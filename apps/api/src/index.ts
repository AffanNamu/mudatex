import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  idleInTransactionTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
});
const app = await buildServer({ config, db });

const close = async () => {
  await app.close();
  await db.end();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
