/**
 * SIP trunks (e.g. Verizon resellers): which IPs may send us calls, and where outgoing calls go.
 * Read from trunks.json; turned into FreeSWITCH config (an IP allow-list and one gateway per trunk).
 */
import { readFileSync } from 'node:fs';

/** How a trunk wants the dialled number written. */
export type NumberFormat = 'e164' | '1+10' | '10';

export interface Trunk {
  /** Letters, numbers, dashes: used as the FreeSWITCH gateway name. */
  name: string;
  /** Addresses that may send calls in (IP or CIDR). Calls from anywhere else are refused. */
  inboundIps: string[];
  /** Where outgoing calls (to buyers) go through this trunk. Leave out for inbound-only trunks. */
  outbound?: {
    host: string;
    port?: number;
    transport?: 'udp' | 'tcp' | 'tls';
    /** Username/password trunks (registration); leave out for IP-authenticated trunks. */
    username?: string;
    password?: string;
    register?: boolean;
    /** Tech prefix some carriers require in front of the number, e.g. "1234#". */
    prefix?: string;
    format?: NumberFormat;
  };
  /** Lower goes first; outgoing calls fail over to the next trunk. */
  priority?: number;
}

export interface TrunkConfig {
  trunks: Trunk[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ADDRESS = /^[0-9a-f.:]+(\/\d{1,3})?$/i;
const HOST = /^[a-z0-9.-]+$/i;

/** Checks a trunks file; throws a readable error naming the problem. */
export function validateTrunks(cfg: unknown): TrunkConfig {
  const c = cfg as TrunkConfig;
  if (!c || !Array.isArray(c.trunks)) throw new Error('trunks.json: expected { "trunks": [ … ] }');
  const seen = new Set<string>();
  for (const t of c.trunks) {
    if (!NAME.test(t.name ?? '')) throw new Error(`trunks.json: name "${t.name}" must be lowercase letters, numbers and dashes`);
    if (seen.has(t.name)) throw new Error(`trunks.json: "${t.name}" is listed twice`);
    seen.add(t.name);
    if (!Array.isArray(t.inboundIps)) throw new Error(`trunks.json: ${t.name}.inboundIps must be a list (can be empty)`);
    for (const ip of t.inboundIps) if (!ADDRESS.test(ip)) throw new Error(`trunks.json: ${t.name}: "${ip}" is not an IP address or range`);
    if (t.outbound) {
      if (!HOST.test(t.outbound.host ?? '')) throw new Error(`trunks.json: ${t.name}.outbound.host is missing or invalid`);
      const f = t.outbound.format ?? 'e164';
      if (!['e164', '1+10', '10'].includes(f)) throw new Error(`trunks.json: ${t.name}.outbound.format must be e164, 1+10 or 10`);
      if (t.outbound.prefix && !/^[0-9*#+]*$/.test(t.outbound.prefix)) throw new Error(`trunks.json: ${t.name}.outbound.prefix may only contain digits, * # +`);
    }
  }
  return c;
}

export function loadTrunks(path: string): TrunkConfig {
  return validateTrunks(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Any number a trunk sends → E.164. US numbers arrive as +1…, 1…, 10 digits, or inside a SIP URI.
 * Hidden / non-numeric caller IDs become "anonymous".
 */
export function toE164(raw: string | undefined): string {
  if (!raw) return 'anonymous';
  let v = raw.trim();
  const sip = v.match(/^(?:sips?|tel):\+?([^@;>]+)/i);
  if (sip) v = sip[1];
  if (/^(anonymous|restricted|unknown|unavailable|private|0000000000)$/i.test(v)) return 'anonymous';
  const plus = v.startsWith('+');
  const digits = v.replace(/\D/g, '');
  if (!digits) return 'anonymous';
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** E.164 → how the trunk wants it dialled. */
export function formatForTrunk(e164: string, format: NumberFormat = 'e164', prefix = ''): string {
  const digits = e164.replace(/\D/g, '');
  const us10 = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const n = format === 'e164' ? `+${digits}` : format === '1+10' ? (us10.length === 10 ? `1${us10}` : digits) : us10;
  return `${prefix}${n}`;
}

/**
 * FreeSWITCH dial string for `to`: a SIP URI goes straight out; a phone number goes through the
 * outbound trunks in priority order (FreeSWITCH tries the next one if a trunk fails).
 */
export function dialString(to: string, cfg: TrunkConfig): string {
  if (/^sips?:/i.test(to)) return `sofia/external/${to.replace(/^sips?:/i, '')}`;
  const outs = cfg.trunks.filter((t) => t.outbound).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  if (!outs.length) throw new Error('No outbound trunk is configured (add "outbound" to a trunk in trunks.json)');
  return outs.map((t) => `sofia/gateway/${t.name}/${formatForTrunk(to, t.outbound!.format, t.outbound!.prefix)}`).join('|');
}

const xml = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** <list> nodes for acl.conf: every trunk's inbound addresses. */
export function aclXml(cfg: TrunkConfig): string {
  const nodes = cfg.trunks.flatMap((t) =>
    t.inboundIps.map((ip) => `      <node type="allow" cidr="${xml(ip.includes('/') ? ip : ip.includes(':') ? `${ip}/128` : `${ip}/32`)}"/> <!-- ${xml(t.name)} -->`),
  );
  return [`<include>`, `    <list name="trunks" default="deny">`, ...nodes, `    </list>`, `</include>`, ''].join('\n');
}

/** One <gateway> per trunk that sends calls out. */
export function gatewaysXml(cfg: TrunkConfig): string {
  const gws = cfg.trunks
    .filter((t) => t.outbound)
    .map((t) => {
      const o = t.outbound!;
      const auth = !!(o.username && o.password);
      const params: [string, string | number][] = [
        ['proxy', `${o.host}:${o.port ?? 5060}`],
        ['realm', o.host],
        ['register', auth && o.register !== false ? 'true' : 'false'],
        ['register-transport', o.transport ?? 'udp'],
        ['caller-id-in-from', 'true'],
        ['ping', '30'],
      ];
      if (auth) params.push(['username', o.username!], ['password', o.password!]);
      else params.push(['username', 'viaroute'], ['password', 'not-used']);
      return [
        `  <gateway name="${xml(t.name)}">`,
        ...params.map(([k, v]) => `    <param name="${k}" value="${xml(v)}"/>`),
        `  </gateway>`,
      ].join('\n');
    });
  return ['<include>', ...gws, '</include>', ''].join('\n');
}
