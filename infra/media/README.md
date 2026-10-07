# ViaRoute media server (SIP trunks)

Connects **SIP trunks** — Verizon resellers, wholesale carriers, anything that sends calls to an IP —
to ViaRoute. ViaRoute makes every decision (campaign, buyer, caps, IVR, billing); the media server only
does the telephony.

```
SIP trunk ──SIP/RTP──► FreeSWITCH ──event socket──► media agent ──HTTPS (Carrier API)──► ViaRoute (Cloudflare)
   ▲                                                    ◄── commands: answer, speak, dial, bridge, record …
   └──── outgoing calls to buyers ◄── FreeSWITCH gateways (trunks.json)
```

API carriers (Twilio, Plivo, SignalWire, Vonage, Bandwidth, Telnyx) don't need this — add them in
Admin → Carriers directly. Use this for trunks that deliver plain SIP.

## What you need

| | |
|---|---|
| A Linux server with a **public IP** | Ubuntu 24.04, US East (near the trunks and ViaRoute's database). 4 vCPU / 8 GB handles ~500–1,000 live calls with recording; 8 vCPU ~1,000–2,000. Add servers to grow. |
| Docker | `curl -fsSL https://get.docker.com \| sh` |
| A DNS name for it | `media1.viaroute.co` → A record to the server IP, **DNS only (grey cloud)** |
| Firewall | TCP 80, 443 (HTTPS); **UDP+TCP 5060 from your trunks' IPs only**; **UDP 16384–32768** (call audio) |
| From each trunk provider | Their signalling IPs (calls come from these), the host to send calls to, number format, auth (IP or username/password). Give them **your server's IP** to whitelist and send calls to. |

## Set up

```bash
git clone https://github.com/riyabishtqr/viaroute.co.git /opt/viaroute && cd /opt/viaroute/infra/media
cp .env.example .env
cp trunks.example.json trunks.json
```

1. **ViaRoute → Admin → Carriers → Add carrier → Custom API**
   - Name: e.g. `Verizon trunks (media1)`
   - API base URL: `https://media1.viaroute.co`
   - API key: make one up (`openssl rand -hex 32`); the same value goes in `.env` as `AGENT_API_KEY`
   - "Carrier has a numbers API": **off** (numbers are added by hand, see below)
   - Copy the **webhook URL** and **webhook secret** it shows into `.env`
2. Fill in the rest of `.env` (`MEDIA_DOMAIN`, `EXTERNAL_IP`, `ESL_PASSWORD`).
3. Put your trunks in `trunks.json`:

   | Field | |
   |---|---|
   | `name` | short id, lowercase, e.g. `verizon-a` |
   | `inboundIps` | the provider's signalling IPs/ranges; calls from any other address are refused |
   | `outbound.host` / `port` | where to send calls to buyers (leave `outbound` out for inbound-only trunks) |
   | `outbound.format` | how they want numbers: `e164` (+14155550142), `1+10` (14155550142) or `10` (4155550142) |
   | `outbound.prefix` | tech prefix if they require one, e.g. `1234#` |
   | `outbound.username` / `password` | only for trunks that authenticate with a login instead of your IP |
   | `priority` | lower first; buyer calls fail over to the next trunk |

4. Start it:
   ```bash
   docker compose up -d --build
   docker compose logs -f agent        # "Media agent listening…", no FreeSWITCH errors
   ```
5. In ViaRoute, **Test connection** on the carrier → green, e.g. `0 call(s) now · 2 trunk(s)`.
6. **Numbers:** Admin → Customers → (customer) → Numbers → **Add existing number**, carrier = this one.
   Ask the provider to point those DIDs at your server IP. Assign each number to a campaign as usual.

Changed `trunks.json`? `docker compose kill -s HUP agent` reloads it without dropping live calls.

## What works

Every Carrier API command: answer, speak (text-to-speech), IVR keypad input, ringing buyers through the trunks
(or `sip:` addresses), whisper, connecting caller and buyer, recording (MP3, copied into ViaRoute's storage),
hang-up and reject. Caller IDs are normalised to E.164; STIR/SHAKEN grades are read from `verstat` or the
`Identity` header when the trunk passes them.

## Operating it

| | |
|---|---|
| Live channels | `docker compose exec freeswitch fs_cli -p "$ESL_PASSWORD" -x "show calls count"` |
| Trunk status | `… -x "sofia status gateway"` |
| Logs | `docker compose logs -f agent` · FreeSWITCH: volume `fslogs` (`/var/log/freeswitch`) |
| Recordings | copied by ViaRoute within minutes; local copies are deleted after `KEEP_RECORDINGS_HOURS` |
| Update | `git pull && docker compose up -d --build` (live calls on FreeSWITCH survive an agent restart) |

## Tests

```bash
# Real SIP calls between two FreeSWITCH containers (one plays the trunk):
docker compose -f infra/media/test/docker-compose.yml up -d --build
pnpm --filter @viaroute/media-agent test        # unit tests
pnpm --filter @viaroute/media-agent test:sip    # 12-step SIP call test against the agent
SIP_E2E=1 pnpm --filter @viaroute/api test sip-media   # the whole thing through a real ViaRoute API
docker compose -f infra/media/test/docker-compose.yml down -v
```
