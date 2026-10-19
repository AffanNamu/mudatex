import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createSecretBox } from './events/secretbox.js';
import { startWorker } from './events/worker.js';
import { allConsumers } from './consumers.js';

// Standalone delivery worker: `node dist/worker.js`.
const config = loadConfig();
const db = createPool(config.DATABASE_URL, { max: 5, statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS });
const handle = startWorker(db, {
  pollMs: config.WORKER_POLL_MS,
  secretBox: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
  urlPolicy: { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE },
  consumers: allConsumers(),
});
const close = async () => { await handle.stop(); await db.end(); };
process.once('SIGTERM', close);
process.once('SIGINT', close);
console.log('Mudatex delivery worker started');
