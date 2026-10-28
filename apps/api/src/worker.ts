import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createSecretBox } from './events/secretbox.js';
import { startWorker } from './events/worker.js';
import { allConsumers } from './consumers.js';
import { mailerFromConfig } from './notify/mailer.js';
import { pusherFromConfig } from './notify/push.js';
import { releaseExpiredReservations } from './inventory/expiry.js';
import { expireUnpaidOrders } from './shop/orders.js';
import { runCollections } from './trade/collections.js';

// Standalone delivery worker: `node dist/worker.js`.
const config = loadConfig();
const db = createPool(config.DATABASE_URL, { max: 5, statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS });
const handle = startWorker(db, {
  pollMs: config.WORKER_POLL_MS,
  secretBox: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
  urlPolicy: { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE },
  consumers: allConsumers(mailerFromConfig(config), pusherFromConfig(config)),
});
// Unpaid orders and expired reservations give their stock back about once a minute.
const sweep = setInterval(() => {
  expireUnpaidOrders(db).then(() => releaseExpiredReservations(db)).catch((err: Error) => console.error('expiry sweep failed', err.message));
}, 60_000);
// Overdue balances are chased once an hour; each reminder goes out once, so the schedule only decides how soon it starts.
const collections = setInterval(() => {
  runCollections(db, mailerFromConfig(config)).catch((err: Error) => console.error('collections failed', err.message));
}, 3_600_000);
const close = async () => { clearInterval(sweep); clearInterval(collections); await handle.stop(); await db.end(); };
process.once('SIGTERM', close);
process.once('SIGINT', close);
console.log('Mudatex delivery worker started');
