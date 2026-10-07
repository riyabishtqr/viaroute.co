import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { attestationOf, hangupCause, sign } from '../src/agent.js';
import { commandBytes, EslParser, parsePlainEvent } from '../src/esl.js';
import { aclXml, dialString, formatForTrunk, gatewaysXml, toE164, validateTrunks, type TrunkConfig } from '../src/trunks.js';

const cfg: TrunkConfig = validateTrunks({
  trunks: [
    { name: 'verizon-b', inboundIps: ['198.51.100.0/24'], outbound: { host: 'sip.b.example', format: '1+10', prefix: '7788#' }, priority: 2 },
    { name: 'verizon-a', inboundIps: ['203.0.113.10'], outbound: { host: '203.0.113.10', port: 5080, format: 'e164' }, priority: 1 },
    { name: 'inbound-only', inboundIps: ['192.0.2.5', '2001:db8::1'] },
  ],
});

test('ESL parser: split messages across chunks, with bodies', () => {
  const got: { h: Record<string, string>; b: string }[] = [];
  const p = new EslParser((h, b) => got.push({ h, b }));
  const msg1 = 'Content-Type: auth/request\n\n';
  const body = 'Event-Name: CHANNEL_PARK\nUnique-ID: abc\nCaller-Caller-ID-Number: %2B13055550100\n\n';
  const msg2 = `Content-Length: ${Buffer.byteLength(body)}\nContent-Type: text/event-plain\n\n${body}`;
  const all = Buffer.from(msg1 + msg2);
  p.push(all.subarray(0, 10));
  p.push(all.subarray(10, 45));
  p.push(all.subarray(45));
  assert.equal(got.length, 2);
  assert.equal(got[0].h['Content-Type'], 'auth/request');
  const ev = parsePlainEvent(got[1].b);
  assert.equal(ev.name, 'CHANNEL_PARK');
  assert.equal(ev.headers['Caller-Caller-ID-Number'], '+13055550100'); // URL-decoded
});

test('ESL commands: arguments with spaces travel in a sized body', () => {
  assert.equal(commandBytes('api status'), 'api status\n\n');
  const text = 'flite|slt|Press 1 for sales, 2 for support.';
  assert.equal(commandBytes('sendmsg x', text), `sendmsg x\ncontent-type: text/plain\ncontent-length: ${Buffer.byteLength(text)}\n\n${text}`);
});

test('numbers from trunks become E.164', () => {
  assert.equal(toE164('4155550142'), '+14155550142');
  assert.equal(toE164('14155550142'), '+14155550142');
  assert.equal(toE164('+14155550142'), '+14155550142');
  assert.equal(toE164('sip:+14155550142@10.0.0.1'), '+14155550142');
  assert.equal(toE164('tel:4155550142'), '+14155550142');
  assert.equal(toE164('(415) 555-0142'), '+14155550142');
  assert.equal(toE164('anonymous'), 'anonymous');
  assert.equal(toE164(''), 'anonymous');
  assert.equal(toE164('Restricted'), 'anonymous');
  assert.equal(toE164('+442071234567'), '+442071234567');
});

test('outgoing number format per trunk', () => {
  assert.equal(formatForTrunk('+14155550142', 'e164'), '+14155550142');
  assert.equal(formatForTrunk('+14155550142', '1+10'), '14155550142');
  assert.equal(formatForTrunk('+14155550142', '10', '99#'), '99#4155550142');
});

test('dial string: trunks in priority order, SIP addresses direct', () => {
  assert.equal(dialString('+14155550142', cfg), 'sofia/gateway/verizon-a/+14155550142|sofia/gateway/verizon-b/7788#14155550142');
  assert.equal(dialString('sip:agent@pbx.example.com', cfg), 'sofia/external/agent@pbx.example.com');
  assert.throws(() => dialString('+14155550142', { trunks: [] }), /No outbound trunk/);
});

test('generated FreeSWITCH config', () => {
  const acl = aclXml(cfg);
  assert.match(acl, /<list name="trunks" default="deny">/);
  assert.match(acl, /cidr="198\.51\.100\.0\/24"/);
  assert.match(acl, /cidr="203\.0\.113\.10\/32"/);
  assert.match(acl, /cidr="2001:db8::1\/128"/);
  const gw = gatewaysXml(cfg);
  assert.match(gw, /<gateway name="verizon-a">[\s\S]*value="203\.0\.113\.10:5080"[\s\S]*name="register" value="false"/);
  assert.doesNotMatch(gw, /inbound-only/);
  const reg = gatewaysXml(validateTrunks({ trunks: [{ name: 'r', inboundIps: [], outbound: { host: 'sip.x', username: 'u', password: 'p<&' } }] }));
  assert.match(reg, /name="register" value="true"/);
  assert.match(reg, /value="p&lt;&amp;"/);
});

test('trunks.json mistakes are reported clearly', () => {
  assert.throws(() => validateTrunks({}), /expected/);
  assert.throws(() => validateTrunks({ trunks: [{ name: 'Bad Name', inboundIps: [] }] }), /lowercase/);
  assert.throws(() => validateTrunks({ trunks: [{ name: 'a', inboundIps: ['not-an-ip'] }] }), /not an IP/);
  assert.throws(() => validateTrunks({ trunks: [{ name: 'a', inboundIps: [] }, { name: 'a', inboundIps: [] }] }), /twice/);
  assert.throws(() => validateTrunks({ trunks: [{ name: 'a', inboundIps: [], outbound: { host: 'x', format: '7' } }] }), /format/);
});

test('hang-up causes', () => {
  assert.equal(hangupCause('NORMAL_CLEARING'), 'normal_clearing');
  assert.equal(hangupCause('USER_BUSY'), 'busy');
  assert.equal(hangupCause('NO_ANSWER'), 'no_answer');
  assert.equal(hangupCause('ALLOTTED_TIMEOUT'), 'no_answer');
  assert.equal(hangupCause('CALL_REJECTED'), 'rejected');
  assert.equal(hangupCause('DESTINATION_OUT_OF_ORDER'), 'destination_out_of_order');
});

test('STIR/SHAKEN grade from verstat or Identity', () => {
  assert.equal(attestationOf({ 'variable_sip_P-Asserted-Identity': '<sip:+14155550142;verstat=TN-Validation-Passed-A@x>' }), 'A');
  const payload = Buffer.from(JSON.stringify({ attest: 'B', orig: { tn: '14155550142' } })).toString('base64url');
  assert.equal(attestationOf({ variable_sip_h_Identity: `eyJhbGciOiJFUzI1NiJ9.${payload}.sig;info=<https://cert>` }), 'B');
  assert.equal(attestationOf({ 'Caller-Caller-ID-Number': '+14155550142' }), undefined);
});

test('webhook signature matches the ViaRoute Carrier API', () => {
  const body = '{"event":"call.inbound"}';
  assert.equal(sign('whsec_x', 1700000000, body), createHmac('sha256', 'whsec_x').update(`1700000000.${body}`).digest('hex'));
});
