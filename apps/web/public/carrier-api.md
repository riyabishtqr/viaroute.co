# ViaRoute Carrier API — v1

This is how any phone carrier, softswitch or SIP platform (FreeSWITCH, Asterisk, Kamailio + a media server, a wholesale carrier's API, …) connects to ViaRoute as a **Custom API carrier**.

ViaRoute makes all routing decisions (which buyer, caps, hours, failover, billing). Your platform only does the telephony: answer, play a message, place a call, connect two calls, record, hang up — and tells ViaRoute what happened.

```
 Caller ──► your platform ──── event: call.inbound ────────────► ViaRoute
                 ▲                                                  │
                 └──── command: answer, speak, dial, bridge … ◄─────┘
```

> **Plain SIP trunks** (Verizon resellers, wholesale carriers): you don't have to build this — the ViaRoute media server
> (FreeSWITCH + media agent, `infra/media`) implements this API for any trunk that sends calls to an IP. See `infra/media/README.md`.

Set it up in **Admin → Carriers → Add carrier → Custom API**. You get:

| From ViaRoute | Put it in your platform |
|---|---|
| Webhook URL — `https://api.<domain>/webhooks/carrier/<carrier id>` | Where you send events |
| Webhook secret — `whsec_…` (shown once) | Key for signing events |

| From you | Put it in ViaRoute |
|---|---|
| API base URL — e.g. `https://switch.example.com/viaroute/v1` | Where ViaRoute sends commands |
| API key | ViaRoute sends it as `Authorization: Bearer <key>` |

---

## 1. Commands (ViaRoute → you)

All requests are `POST` with a JSON body (possibly `{}`), header `Authorization: Bearer <API key>`, and must answer within **8 seconds** with a `2xx` status. On failure answer `4xx/5xx` with `{ "error": "human readable reason" }`.

`{callId}` is **your** id for a call leg (the one you sent in `call.inbound`, or returned from `POST /calls`).

| Command | Body | What to do |
|---|---|---|
| `POST /calls/{callId}/answer` | — | Answer the incoming call. |
| `POST /calls/{callId}/speak` | `{ "text": "…", "voice": "female", "language": "en-US" }` | Play the text as speech. Send `call.speak_ended` when it finishes. |
| `POST /calls` | `{ "to": "+12125550123", "from": "+14155550100", "timeoutSec": 20, "linkTo": "<caller's callId>" }` | Start a new outgoing leg to `to` (E.164 number or `sip:` URI), showing `from` as caller ID. Ring for at most `timeoutSec`. Answer `{ "callId": "<new leg id>" }` right away (before it is answered). Send `call.answered` when it's picked up, or `call.hangup` if it's not. |
| `POST /calls/{callId}/bridge` | `{ "otherCallId": "…" }` | Connect the two legs' audio. |
| `POST /calls/{callId}/record` | — | Record the (bridged) call. Send `call.recording_saved` when the file is ready. |
| `POST /calls/{callId}/hangup` | — | Hang up that leg. It's fine if it's already gone. |
| `POST /calls/{callId}/reject` | — | Refuse an unanswered incoming call. |
| `POST /calls/{callId}/gather` | `{ "text": "Press 1 for sales…", "minDigits": 1, "maxDigits": 1, "timeoutSec": 6, "terminator": "#" }` | IVR: play the text and collect keypad digits (stop early on `#` or `maxDigits`). Send `call.gathered` with what was pressed — also when nothing was (`"digits": ""`). |

Also required:

| Request | Answer |
|---|---|
| `GET /health` | `{ "ok": true, "message": "optional, e.g. 214 channels free" }` — used by **Test connection**. |

## 2. Events (you → ViaRoute)

`POST` JSON to your webhook URL. Answer is always `200` once the signature is valid.

```json
{ "event": "call.inbound", "callId": "abc-123", "from": "+13055550100", "to": "+14155550142", "at": "2026-09-25T14:03:11.250Z" }
```

| `event` | Fields | When |
|---|---|---|
| `call.inbound` | `callId`, `from`, `to`, `at`, optional `attestation` | A call arrives on one of the numbers (`to`). Don't answer it yourself — wait for the `answer` command. Send the STIR/SHAKEN grade of the caller ID as `attestation`: `"A"`, `"B"` or `"C"` (leave it out if the call wasn't signed) — campaigns can require a minimum grade. Hidden caller IDs: send `"from": "anonymous"`. |
| `call.answered` | `callId`, `at` | An outgoing leg you started with `POST /calls` was answered. |
| `call.speak_ended` | `callId`, `at` | A `speak` command finished playing — on any leg (ViaRoute also speaks a short *whisper* to the buyer's leg before bridging). |
| `call.gathered` | `callId`, `digits`, `at` | A `gather` finished: the keys pressed (`""` if none, a trailing `#` is fine). |
| `call.hangup` | `callId`, `at`, `cause` | **Any** leg ended — caller or buyer, answered or not (`cause`: e.g. `normal_clearing`, `no_answer`, `busy`, `timeout`). |
| `call.recording_saved` | `callId` (the caller's leg), `recordingUrl` | The recording is ready. The URL must be downloadable (no login) for at least 10 minutes; ViaRoute copies it. `.mp3` or `.wav`. |

`at` is when it happened (ISO 8601). It's used for talk time and billing, so send the real event time, not when you send the webhook.

### Signing

Every event carries:

```
X-ViaRoute-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" using the webhook secret>
```

Events older than 5 minutes are rejected. Example (Node.js):

```js
const t = Math.floor(Date.now() / 1000);
const body = JSON.stringify(event);
const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ViaRoute-Signature': `t=${t},v1=${v1}` }, body });
```

Python:

```python
t = str(int(time.time()))
body = json.dumps(event)
v1 = hmac.new(WEBHOOK_SECRET.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
requests.post(WEBHOOK_URL, data=body, headers={"Content-Type": "application/json", "X-ViaRoute-Signature": f"t={t},v1={v1}"})
```

Send each event once; if you retry after a network error, ViaRoute ignores duplicates of `call.inbound` and `call.answered`.

## 3. A normal call

```
you → call.inbound  {callId: "in-1", from, to}
ViaRoute → POST /calls/in-1/answer
ViaRoute → POST /calls/in-1/speak  {"text": "This call may be recorded…"}
you → call.speak_ended {callId: "in-1"}
ViaRoute → POST /calls {to: buyer, from: tracking number, timeoutSec: 20, linkTo: "in-1"}   ← {callId: "out-1"}
you → call.answered {callId: "out-1"}                 (or call.hangup {callId: "out-1", cause: "no_answer"} → ViaRoute dials the next buyer)
ViaRoute → POST /calls/in-1/bridge {otherCallId: "out-1"}
ViaRoute → POST /calls/in-1/record
… talking …
you → call.hangup {callId: "in-1", cause: "normal_clearing"}      (caller hung up)
ViaRoute → POST /calls/out-1/hangup
you → call.hangup {callId: "out-1"}
you → call.recording_saved {callId: "in-1", recordingUrl}
```

## 4. Numbers (optional)

Turn on **"Carrier has a numbers API"** in ViaRoute if you implement these; customers can then search and buy numbers themselves. Without them, the platform admin adds numbers to customers by hand (**Admin → Customers → Numbers → Add existing number**), and releasing a number only takes it out of use in ViaRoute.

| Request | Answer |
|---|---|
| `GET /numbers/available?country=US&type=local\|toll_free&areaCode=415&limit=20` | `{ "numbers": [{ "e164": "+14155550177", "monthlyCost": 1.0, "upfrontCost": 0, "locality": "San Francisco", "region": "CA" }] }` — costs are what you charge the platform (USD). |
| `POST /numbers` `{ "e164": "+14155550177", "reference": "tenant:<id>" }` | `{ "status": "active" \| "pending" \| "failed", "id": "your number id", "error": "if failed" }`. Route its calls to ViaRoute from now on. |
| `GET /numbers/{e164}` | Same shape — used to re-check a `pending` order. |
| `DELETE /numbers/{e164}` | `2xx` when released. |

## 5. Checklist

- [ ] `GET /health` answers `{ "ok": true }` → **Test connection** is green
- [ ] Events are signed; **Last webhook** in Admin → Carriers shows "just now" after a test call
- [ ] Every leg sends exactly one `call.hangup`
- [ ] `at` times are real event times (billing depends on them)
- [ ] Recording URLs are public for ≥ 10 minutes
