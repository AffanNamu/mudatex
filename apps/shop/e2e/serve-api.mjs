// Prepares a clean database, starts the API, fills the shop with a small realistic catalogue through the API
// (exactly as an administrator would), and only then opens port 3199 to tell Playwright it may build and start the shop.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = resolve(here, '../../api');

await new Promise((ok, fail) => {
  const p = spawn('node', [resolve(here, '../../web/e2e/prepare.mjs')], { stdio: 'inherit', env: process.env });
  p.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`prepare exited ${c}`))));
});

const server = spawn('node', [`${api}/dist/index.js`], { stdio: 'inherit', env: process.env });
const stop = () => { server.kill('SIGTERM'); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', (c) => process.exit(c ?? 1));

const API = `http://localhost:${process.env.PORT}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${API}/ready`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 300));
}

const { seedShop } = await import('./seed-shop.mjs');
await seedShop(API);
createServer((_req, res) => res.end('seeded')).listen(3199);
