// Runs wrangler with a login of its own for this project (stored in .wrangler/home, not in your
// global wrangler settings), so ViaRoute's Cloudflare account never mixes with your other accounts.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const res = spawnSync(bin, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, XDG_CONFIG_HOME: join(root, '.wrangler', 'home') },
});
process.exit(res.status ?? 1);
