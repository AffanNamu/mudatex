import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { allConsumers } from './consumers.js';
import { mailerFromConfig } from './notify/mailer.js';
import { createSecretBox } from './events/secretbox.js';
import { startWorker } from './events/worker.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  idleInTransactionTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
});
const app = await buildServer({ config, db });

const worker = config.RUN_WORKER_IN_API
  ? startWorker(db, {
      pollMs: config.WORKER_POLL_MS,
      secretBox: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
      urlPolicy: { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE },
      consumers: allConsumers(mailerFromConfig(config)),
    })
  : null;

const close = async () => {
  await worker?.stop();
  await app.close();
  await db.end();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
