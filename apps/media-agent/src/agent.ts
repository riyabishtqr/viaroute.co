/**
 * ViaRoute media agent: FreeSWITCH (SIP trunks) ⇄ ViaRoute Carrier API v1 (docs/CARRIER_API.md).
 *
 *   SIP trunk ─► FreeSWITCH parks the call ─► agent ─► ViaRoute: call.inbound
 *   ViaRoute ─► agent HTTP API (answer, speak, gather, dial, bridge, record, hangup) ─► FreeSWITCH
 *   FreeSWITCH events ─► agent ─► ViaRoute: call.answered / speak_ended / gathered / hangup / recording_saved
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { EslClient, type EslEvent } from './esl.js';
import { aclXml, dialString, gatewaysXml, toE164, type TrunkConfig } from './trunks.js';

export interface AgentConfig {
  /** ViaRoute → Admin → Carriers → (this carrier): webhook URL and secret. */
  webhookUrl: string;
  webhookSecret: string;
  /** ViaRoute sends it as "Authorization: Bearer …" (the carrier's API key in ViaRoute). */
  apiKey: string;
  /** This server's public HTTPS address (recording links point here). */
  publicUrl: string;
  listenHost: string;
  listenPort: number;
  esl: { host: string; port: number; password: string };
  trunks: TrunkConfig;
  /** Where FreeSWITCH includes the generated allow-list and gateways from. */
  generatedDir: string;
  /** Where FreeSWITCH writes recordings (shared with this agent). */
  recordingsDir: string;
  ttsVoice: string;
  keepRecordingsHours: number;
  log?: (m: string) => void;
}

/** FreeSWITCH hang-up causes → the short names ViaRoute shows. */
export function hangupCause(fs: string | undefined): string {
  const c = (fs ?? 'NORMAL_CLEARING').toUpperCase();
  if (c === 'USER_BUSY') return 'busy';
  if (['NO_ANSWER', 'NO_USER_RESPONSE', 'ALLOTTED_TIMEOUT', 'RECOVERY_ON_TIMER_EXPIRE', 'PROGRESS_TIMEOUT'].includes(c)) return 'no_answer';
  if (c === 'CALL_REJECTED') return 'rejected';
  return c.toLowerCase();
}

/** STIR/SHAKEN grade from what the trunk passed: verstat (TN-Validation-Passed-A) or an Identity header's "attest". */
export function attestationOf(h: Record<string, string>): 'A' | 'B' | 'C' | undefined {
  for (const v of Object.values(h)) {
    const m = v.match(/verstat=TN-Validation-Passed-([ABC])/i);
    if (m) return m[1].toUpperCase() as 'A' | 'B' | 'C';
  }
  const identity = h['variable_sip_h_Identity'];
  if (identity) {
    const payload = identity.split(';')[0].split('.')[1];
    try {
      const attest = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).attest;
      if (['A', 'B', 'C'].includes(attest)) return attest;
    } catch {
      /* not a SHAKEN PASSporT */
    }
  }
  return undefined;
}

/** Text for FreeSWITCH TTS: one line, no characters that end an argument. */
const speakable = (t: string) => t.replace(/[\r\n|']+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

export function sign(secret: string, t: number, body: string) {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

interface CallState {
  direction: 'inbound' | 'outbound';
  announced?: boolean;
  hungUp?: boolean;
  /** The outgoing leg's originate job, to report failures that never created a channel. */
  jobId?: string;
}

type Pending = { callId: string; kind: 'speak' | 'gather' };

export class MediaAgent {
  readonly esl: EslClient;
  private calls = new Map<string, CallState>();
  private pending = new Map<string, Pending>(); // execute Event-UUID → what it was for
  private jobs = new Map<string, string>(); // originate Job-UUID → leg id
  private queues = new Map<string, Promise<void>>(); // per-call webhook order
  private server?: Server;
  private cleanup?: NodeJS.Timeout;

  constructor(private cfg: AgentConfig) {
    this.esl = new EslClient({
      ...cfg.esl,
      events: ['CHANNEL_PARK', 'CHANNEL_ANSWER', 'CHANNEL_HANGUP_COMPLETE', 'CHANNEL_EXECUTE_COMPLETE', 'RECORD_STOP', 'BACKGROUND_JOB'],
      log: cfg.log,
    });
    this.esl.on('event', (e: EslEvent) => void this.onEvent(e).catch((err) => this.log(`event ${e.name}: ${(err as Error).message}`)));
    this.esl.on('ready', () => void this.applyTrunks().catch((err) => this.log(`trunks: ${(err as Error).message}`)));
  }

  private log(m: string) {
    this.cfg.log?.(m);
  }

  async start() {
    await this.writeTrunkFiles();
    this.esl.start();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(this.cfg.listenPort, this.cfg.listenHost, r));
    this.cleanup = setInterval(() => void this.removeOldRecordings(), 3600_000);
    this.cleanup.unref();
    this.log(`Media agent listening on ${this.cfg.listenHost}:${this.cfg.listenPort}, ${this.cfg.trunks.trunks.length} trunk(s)`);
  }

  async stop() {
    clearInterval(this.cleanup);
    this.esl.stop();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // ---------------------------------------------------------------------------
  // Trunks → FreeSWITCH
  // ---------------------------------------------------------------------------

  async setTrunks(trunks: TrunkConfig) {
    this.cfg.trunks = trunks;
    await this.writeTrunkFiles();
    if (this.esl.ready) await this.applyTrunks();
  }

  private async writeTrunkFiles() {
    await mkdir(this.cfg.generatedDir, { recursive: true });
    await mkdir(join(this.cfg.generatedDir, 'acl'), { recursive: true });
    await mkdir(join(this.cfg.generatedDir, 'gateways'), { recursive: true });
    await writeAtomic(join(this.cfg.generatedDir, 'acl', 'trunks.xml'), aclXml(this.cfg.trunks));
    await writeAtomic(join(this.cfg.generatedDir, 'gateways', 'trunks.xml'), gatewaysXml(this.cfg.trunks));
  }

  /** Makes FreeSWITCH re-read the allow-list and gateways. */
  private async applyTrunks() {
    await this.esl.api('reloadxml');
    await this.esl.api('reloadacl');
    await this.esl.api('sofia profile external rescan');
    for (const t of this.cfg.trunks.trunks.filter((x) => !x.outbound)) await this.esl.api(`sofia profile external killgw ${t.name}`);
  }

  // ---------------------------------------------------------------------------
  // FreeSWITCH events → ViaRoute
  // ---------------------------------------------------------------------------

  private at(e: EslEvent) {
    const us = Number(e.headers['Event-Date-Timestamp']);
    return (us ? new Date(us / 1000) : new Date()).toISOString();
  }

  async onEvent(e: EslEvent) {
    const h = e.headers;
    const id = h['Unique-ID'];
    switch (e.name) {
      case 'CHANNEL_PARK': {
        if (h['variable_vr_inbound'] !== 'true' || !id) return;
        const call = this.calls.get(id) ?? { direction: 'inbound' as const };
        if (call.announced) return; // parked again after a bridge ends
        call.announced = true;
        this.calls.set(id, call);
        const attestation = attestationOf(h);
        await this.emit(id, {
          event: 'call.inbound',
          callId: id,
          from: toE164(h['Caller-Caller-ID-Number']),
          to: toE164(h['Caller-Destination-Number']),
          at: this.at(e),
          ...(attestation ? { attestation } : {}),
        });
        return;
      }
      case 'CHANNEL_ANSWER': {
        if (h['variable_vr_outbound'] === 'true' && id && this.calls.has(id)) await this.emit(id, { event: 'call.answered', callId: id, at: this.at(e) });
        return;
      }
      case 'CHANNEL_EXECUTE_COMPLETE': {
        const p = this.pending.get(h['Application-UUID'] ?? '');
        if (!p) return;
        this.pending.delete(h['Application-UUID']);
        if (p.kind === 'speak') await this.emit(p.callId, { event: 'call.speak_ended', callId: p.callId, at: this.at(e) });
        else await this.emit(p.callId, { event: 'call.gathered', callId: p.callId, digits: h['variable_vr_digits'] ?? '', at: this.at(e) });
        return;
      }
      case 'CHANNEL_HANGUP_COMPLETE': {
        const call = id ? this.calls.get(id) : undefined;
        if (!call || call.hungUp) return;
        call.hungUp = true;
        await this.emit(id, { event: 'call.hangup', callId: id, cause: hangupCause(h['Hangup-Cause']), at: this.at(e) });
        setTimeout(() => this.forget(id), 120_000).unref();
        return;
      }
      case 'RECORD_STOP': {
        const path = h['Record-File-Path'];
        if (!id || !path || !path.startsWith(this.cfg.recordingsDir)) return;
        await this.emit(id, { event: 'call.recording_saved', callId: id, recordingUrl: this.recordingUrl(basename(path)) });
        return;
      }
      case 'BACKGROUND_JOB': {
        const legId = this.jobs.get(h['Job-UUID'] ?? '');
        if (!legId) return;
        this.jobs.delete(h['Job-UUID']);
        const result = e.body.trim();
        const call = this.calls.get(legId);
        // The originate failed before any channel existed (e.g. trunk unreachable): report the hang-up ourselves.
        if (result.startsWith('-ERR') && call && !call.hungUp) {
          setTimeout(async () => {
            if (call.hungUp) return;
            call.hungUp = true;
            await this.emit(legId, { event: 'call.hangup', callId: legId, cause: hangupCause(result.replace(/^-ERR\s*/, '')), at: new Date().toISOString() });
            this.forget(legId);
          }, 1500).unref();
        }
        return;
      }
    }
  }

  private forget(id: string) {
    this.calls.delete(id);
    this.queues.delete(id);
  }

  /** Signed POST to ViaRoute, in order per call, retried on network errors and 5xx. */
  emit(callId: string, event: Record<string, unknown>): Promise<void> {
    const prev = this.queues.get(callId) ?? Promise.resolve();
    const next = prev.then(() => this.post(event)).catch((e) => this.log(`webhook ${event.event} for ${callId}: ${(e as Error).message}`));
    this.queues.set(callId, next);
    return next;
  }

  private async post(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    for (let attempt = 1; ; attempt++) {
      const t = Math.floor(Date.now() / 1000);
      try {
        const res = await fetch(this.cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ViaRoute-Signature': `t=${t},v1=${sign(this.cfg.webhookSecret, t, body)}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        if (res.status < 500 || attempt >= 4) throw new Error(`ViaRoute answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } catch (e) {
        if (attempt >= 4) throw e;
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }

  // ---------------------------------------------------------------------------
  // ViaRoute → FreeSWITCH (Carrier API commands)
  // ---------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://agent');
      if (req.method === 'GET' && url.pathname.startsWith('/recordings/')) return this.serveRecording(url, res);
      if (!this.authorized(req)) return send(401, { error: 'Wrong or missing API key' });

      const body = req.method === 'POST' ? await readJson(req) : {};
      const path = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && path === '/health') return send(200, await this.health());
      if (req.method === 'POST' && path === '/calls') return send(200, await this.dial(body));
      const m = path.match(/^\/calls\/([A-Za-z0-9-]+)\/(answer|speak|bridge|record|hangup|reject|gather)$/);
      if (req.method === 'POST' && m) return send(200, await this.command(m[1], m[2], body));
      if (path.startsWith('/numbers')) return send(404, { error: 'This carrier has no numbers API: add numbers in ViaRoute by hand' });
      return send(404, { error: 'Not found' });
    } catch (e) {
      send(e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
    }
  }

  private authorized(req: IncomingMessage) {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.cfg.apiKey);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async health() {
    if (!this.esl.ready) return { ok: false, message: 'FreeSWITCH is not connected' };
    const status = await this.esl.api('show calls count');
    const calls = Number(status.match(/(\d+)\s+total/)?.[1] ?? 0);
    const gw = await this.esl.api('sofia status gateway');
    const down = this.cfg.trunks.trunks.filter((t) => t.outbound && new RegExp(`\\b${t.name}\\b.*\\b(DOWN|FAIL)`, 'i').test(gw)).map((t) => t.name);
    return { ok: true, message: `${calls} call(s) now · ${this.cfg.trunks.trunks.length} trunk(s)${down.length ? ` · down: ${down.join(', ')}` : ''}` };
  }

  /** POST /calls: ring a buyer through the outbound trunks (or a sip: address). Answers at once. */
  async dial(body: Record<string, unknown>) {
    const to = String(body.to ?? '');
    const from = String(body.from ?? '');
    const timeoutSec = Math.min(Math.max(Number(body.timeoutSec) || 30, 5), 120);
    if (!to) throw new HttpError(400, '"to" is required');
    let target: string;
    try {
      target = dialString(/^sips?:/i.test(to) ? to : toE164(to), this.cfg.trunks);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const legId = randomUUID();
    const jobId = randomUUID();
    const callerId = from.replace(/[^\d+]/g, '') || 'anonymous';
    const vars = [
      `origination_uuid=${legId}`,
      'vr_outbound=true',
      `origination_caller_id_number=${callerId}`,
      `origination_caller_id_name=${callerId}`,
      `originate_timeout=${timeoutSec}`,
      'ignore_early_media=true',
      'hangup_after_bridge=false',
      'media_timeout=300000',
      'tts_engine=flite',
      `tts_voice=${this.cfg.ttsVoice}`,
      body.linkTo ? `vr_link=${String(body.linkTo).replace(/[^A-Za-z0-9-]/g, '')}` : '',
    ].filter(Boolean);
    this.calls.set(legId, { direction: 'outbound', jobId });
    this.jobs.set(jobId, legId);
    await this.esl.bgapi(`originate {${vars.join(',')}}${target} &park()`, jobId);
    return { callId: legId };
  }

  async command(id: string, action: string, body: Record<string, unknown>) {
    const ok = (r: string) => {
      if (r.startsWith('-ERR') && !/No such channel/i.test(r)) throw new HttpError(409, r.replace(/^-ERR\s*/, ''));
      return { ok: true };
    };
    switch (action) {
      case 'answer':
        await this.esl.execute(id, 'answer', '', randomUUID());
        return { ok: true };
      case 'speak': {
        const ev = randomUUID();
        this.pending.set(ev, { callId: id, kind: 'speak' });
        await this.esl.execute(id, 'speak', `flite|${this.cfg.ttsVoice}|${speakable(String(body.text ?? ''))}`, ev);
        return { ok: true };
      }
      case 'gather': {
        const min = Math.max(Number(body.minDigits) || 1, 1);
        const max = Math.max(Number(body.maxDigits) || 1, min);
        const timeoutMs = Math.min(Math.max(Number(body.timeoutSec) || 6, 1), 60) * 1000;
        const term = String(body.terminator ?? '#').replace(/[^0-9*#]/g, '') || 'none';
        const prompt = speakable(String(body.text ?? ''));
        const ev = randomUUID();
        this.pending.set(ev, { callId: id, kind: 'gather' });
        await this.esl.api(`uuid_setvar ${id} vr_digits ''`);
        const file = prompt ? `'say:${prompt}'` : 'silence_stream://250';
        await this.esl.execute(id, 'play_and_get_digits', `${min} ${max} 1 ${timeoutMs} ${term} ${file} silence_stream://250 vr_digits \\d+ ${timeoutMs}`, ev);
        return { ok: true };
      }
      case 'bridge': {
        const other = String(body.otherCallId ?? '').replace(/[^A-Za-z0-9-]/g, '');
        if (!other) throw new HttpError(400, '"otherCallId" is required');
        return ok(await this.esl.api(`uuid_bridge ${id} ${other}`));
      }
      case 'record': {
        await mkdir(this.cfg.recordingsDir, { recursive: true });
        await this.esl.api(`uuid_setvar ${id} RECORD_STEREO false`);
        return ok(await this.esl.api(`uuid_record ${id} start ${join(this.cfg.recordingsDir, `${id}.mp3`)}`));
      }
      case 'hangup':
        return ok(await this.esl.api(`uuid_kill ${id} NORMAL_CLEARING`));
      case 'reject':
        return ok(await this.esl.api(`uuid_kill ${id} CALL_REJECTED`));
    }
    throw new HttpError(404, 'Unknown command');
  }

  // ---------------------------------------------------------------------------
  // Recordings: links that work without a login for a while (ViaRoute copies them)
  // ---------------------------------------------------------------------------

  recordingUrl(file: string, ttlSec = 24 * 3600) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = createHmac('sha256', this.cfg.apiKey).update(`${file}:${exp}`).digest('base64url');
    return `${this.cfg.publicUrl.replace(/\/$/, '')}/recordings/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
  }

  private async serveRecording(url: URL, res: ServerResponse) {
    const file = decodeURIComponent(url.pathname.slice('/recordings/'.length));
    const exp = Number(url.searchParams.get('exp'));
    const want = createHmac('sha256', this.cfg.apiKey).update(`${file}:${exp}`).digest('base64url');
    const given = url.searchParams.get('sig') ?? '';
    const valid = /^[A-Za-z0-9-]+\.(mp3|wav)$/.test(file) && exp > Date.now() / 1000 && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!valid) {
      res.writeHead(403).end('Link expired');
      return;
    }
    const path = join(this.cfg.recordingsDir, file);
    try {
      const s = await stat(path);
      res.writeHead(200, { 'Content-Type': file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', 'Content-Length': s.size });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }

  /** ViaRoute copies recordings within minutes; local copies are deleted after keepRecordingsHours. */
  async removeOldRecordings() {
    const cutoff = Date.now() - this.cfg.keepRecordingsHours * 3600_000;
    for (const f of await readdir(this.cfg.recordingsDir).catch(() => [] as string[])) {
      const p = join(this.cfg.recordingsDir, f);
      const s = await stat(p).catch(() => null);
      if (s && s.mtimeMs < cutoff) await unlink(p).catch(() => {});
    }
  }
}

/** Write then rename: FreeSWITCH never reads a half-written file, and files we don't own get replaced. */
async function writeAtomic(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}
