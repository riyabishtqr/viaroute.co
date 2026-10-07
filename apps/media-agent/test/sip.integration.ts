/**
 * Real SIP calls through the media server, end to end (no mocks):
 *   fake trunk (FreeSWITCH) ──SIP/RTP──► media server (FreeSWITCH) ◄──ESL── agent ──webhooks──► this test (as ViaRoute)
 *
 *   docker compose -f infra/media/test/docker-compose.yml up -d --build
 *   pnpm --filter @viaroute/media-agent test:sip
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EslClient } from '../src/esl.js';

const AGENT = 'http://localhost:18088';
const KEY = 'test-agent-key';
const SECRET = 'whsec_test';

type Hook = Record<string, unknown> & { event: string; callId: string };
const hooks: Hook[] = [];
let badSignatures = 0;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = String(req.headers['x-viaroute-signature'] ?? '');
    const t = sig.match(/t=(\d+)/)?.[1] ?? '';
    const v1 = sig.match(/v1=([0-9a-f]+)/)?.[1] ?? '';
    if (createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex') !== v1) badSignatures++;
    hooks.push(JSON.parse(body));
    res.writeHead(200).end('{}');
  });
});

async function waitFor(what: string, pred: (h: Hook) => boolean, ms = 15_000): Promise<Hook> {
  const until = Date.now() + ms;
  for (;;) {
    const hit = hooks.find(pred);
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}. Got: ${hooks.map((h) => `${h.event}(${h.callId})`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function agent(path: string, body?: unknown, key = KEY) {
  const res = await fetch(`${AGENT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status >= 400) console.log(`  (agent ${path} → ${res.status}: ${JSON.stringify(json)})`);
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steps: string[] = [];
const step = (s: string) => {
  steps.push(s);
  console.log(`✔ ${s}`);
};

async function main() {
  await new Promise<void>((r) => server.listen(18099, '0.0.0.0', r));
  const carrier = new EslClient({ host: '127.0.0.1', port: 18021, password: 'carrier', events: ['CHANNEL_ANSWER'] });
  carrier.start();
  await new Promise((r) => carrier.once('ready', r));

  // 0) Health and auth
  const health = await agent('/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true, JSON.stringify(health.json));
  assert.equal((await agent('/health', undefined, 'wrong-key')).status, 401);
  step(`health: ${health.json.message}`);

  // 1) The trunk sends a call in (10-digit caller ID, like many carriers do)
  const callerLeg = randomUUID();
  // bgapi: a blocking originate would hold the trunk's event socket until the call is answered.
  await carrier.bgapi(
    `originate {origination_uuid=${callerLeg},origination_caller_id_number=3055550100}sofia/external/4155550142@172.29.0.10:5060 &endless_playback(tone_stream://%(1000,500,350))`,
    randomUUID(),
  );
  const inbound = await waitFor('call.inbound', (h) => h.event === 'call.inbound');
  assert.equal(inbound.from, '+13055550100');
  assert.equal(inbound.to, '+14155550142');
  const A = inbound.callId;
  step(`call.inbound from ${inbound.from} to ${inbound.to}`);

  // 2) Answer + speak (TTS) → speak_ended
  assert.equal((await agent(`/calls/${A}/answer`, {})).status, 200);
  assert.equal((await agent(`/calls/${A}/speak`, { text: "This call may be recorded. Connecting you now, it's quick." })).status, 200);
  await waitFor('call.speak_ended', (h) => h.event === 'call.speak_ended' && h.callId === A);
  step('answer + speak → call.speak_ended');

  // 3) IVR: gather one digit; the caller presses 2 while the prompt plays
  assert.equal((await agent(`/calls/${A}/gather`, { text: 'Press 1 for sales, 2 for support.', minDigits: 1, maxDigits: 1, timeoutSec: 8 })).status, 200);
  await sleep(1500);
  await carrier.api(`uuid_send_dtmf ${callerLeg} 2`);
  const gathered = await waitFor('call.gathered', (h) => h.event === 'call.gathered' && h.callId === A);
  assert.equal(gathered.digits, '2');
  step('gather → caller pressed 2 → call.gathered "2"');

  // 4) Gather with nothing pressed → empty digits
  assert.equal((await agent(`/calls/${A}/gather`, { text: 'Press a key.', maxDigits: 1, timeoutSec: 2 })).status, 200);
  const none = await waitFor('empty call.gathered', (h) => h.event === 'call.gathered' && h.callId === A && h !== gathered);
  assert.equal(none.digits, '');
  step('gather timeout → call.gathered ""');

  // 5) A busy buyer: the leg ends with cause "busy", never "answered"
  const busy = await agent('/calls', { to: '+12125550000', from: '+14155550142', timeoutSec: 10, linkTo: A });
  assert.equal(busy.status, 200);
  const busyLeg = String(busy.json.callId);
  const busyEnd = await waitFor('busy hangup', (h) => h.event === 'call.hangup' && h.callId === busyLeg);
  assert.equal(busyEnd.cause, 'busy');
  assert.equal(hooks.some((h) => h.event === 'call.answered' && h.callId === busyLeg), false);
  step('dial busy buyer → call.hangup cause "busy"');

  // 6) Ring the buyer through the trunk, it answers
  const dial = await agent('/calls', { to: '+12125550199', from: '+14155550142', timeoutSec: 15, linkTo: A });
  assert.equal(dial.status, 200);
  const B = String(dial.json.callId);
  await waitFor('call.answered', (h) => h.event === 'call.answered' && h.callId === B);
  step('dial buyer through the trunk → call.answered');

  // 7) Whisper to the buyer, then connect and record
  assert.equal((await agent(`/calls/${B}/speak`, { text: 'Call from ViaRoute.' })).status, 200);
  await waitFor('whisper ended', (h) => h.event === 'call.speak_ended' && h.callId === B);
  assert.equal((await agent(`/calls/${A}/bridge`, { otherCallId: B })).status, 200);
  assert.equal((await agent(`/calls/${A}/record`, {})).status, 200);
  await sleep(4000);
  step('whisper + bridge + record (4 s of talk)');

  // 8) The buyer hangs up; ViaRoute then hangs up the caller
  assert.equal((await agent(`/calls/${B}/hangup`, {})).status, 200);
  const bEnd = await waitFor('buyer hangup', (h) => h.event === 'call.hangup' && h.callId === B);
  assert.equal(bEnd.cause, 'normal_clearing');
  assert.equal((await agent(`/calls/${A}/hangup`, {})).status, 200);
  await waitFor('caller hangup', (h) => h.event === 'call.hangup' && h.callId === A);
  step('hangups reported for both legs');

  // 9) The recording: signed link, real MP3 audio
  const rec = await waitFor('call.recording_saved', (h) => h.event === 'call.recording_saved' && h.callId === A);
  const audio = await fetch(String(rec.recordingUrl));
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.ok(bytes.length > 4000, `recording only ${bytes.length} bytes`);
  assert.ok(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0), 'not an MP3');
  const tampered = String(rec.recordingUrl).replace(/sig=[^&]+/, 'sig=AAAA');
  assert.equal((await fetch(tampered)).status, 403);
  step(`recording: ${bytes.length} bytes of MP3, link signed`);

  // 10) Exactly one hangup per leg; every webhook signed
  for (const leg of [A, B, busyLeg]) assert.equal(hooks.filter((h) => h.event === 'call.hangup' && h.callId === leg).length, 1, `hangups for ${leg}`);
  assert.equal(badSignatures, 0);
  step('one call.hangup per leg; all webhooks correctly signed');

  // 11) Unknown commands and calls
  assert.equal((await agent('/calls', { from: '+1' })).status, 400);
  assert.equal((await agent(`/calls/${A}/bridge`, {})).status, 400);
  step('bad requests answered 400');

  carrier.stop();
  server.close();
  console.log(`\nSIP integration: ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
});
