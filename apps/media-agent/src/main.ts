import { MediaAgent } from './agent.js';
import { loadTrunks } from './trunks.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing setting ${name} (see infra/media/.env.example)`);
    process.exit(1);
  }
  return v;
}

const trunksFile = process.env.TRUNKS_FILE ?? '/etc/viaroute/trunks.json';
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const agent = new MediaAgent({
  webhookUrl: need('VIAROUTE_WEBHOOK_URL'),
  webhookSecret: need('VIAROUTE_WEBHOOK_SECRET'),
  apiKey: need('AGENT_API_KEY'),
  publicUrl: need('PUBLIC_URL'),
  listenHost: process.env.LISTEN_HOST ?? '127.0.0.1',
  listenPort: Number(process.env.LISTEN_PORT ?? 8088),
  esl: { host: process.env.ESL_HOST ?? '127.0.0.1', port: Number(process.env.ESL_PORT ?? 8021), password: need('ESL_PASSWORD') },
  trunks: loadTrunks(trunksFile),
  generatedDir: process.env.FS_GENERATED_DIR ?? '/etc/freeswitch/viaroute',
  recordingsDir: process.env.RECORDINGS_DIR ?? '/recordings',
  ttsVoice: process.env.TTS_VOICE ?? 'slt',
  keepRecordingsHours: Number(process.env.KEEP_RECORDINGS_HOURS ?? 24),
  log,
});

await agent.start();

// Edit trunks.json, then: docker compose kill -s HUP agent  (no restart, live calls keep going)
process.on('SIGHUP', () => {
  try {
    void agent.setTrunks(loadTrunks(trunksFile)).then(() => log('Trunks reloaded'));
  } catch (e) {
    log(`Trunks not reloaded: ${(e as Error).message}`);
  }
});
for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => void agent.stop().then(() => process.exit(0)));
