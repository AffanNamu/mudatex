import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { allConsumers } from './consumers.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { Dispatcher } from './events/dispatcher.js';
import { purgeDelivered, purgeIdempotencyKeys } from './events/maintenance.js';
import { createSecretBox } from './events/secretbox.js';
import { buildServer } from './server.js';

/** Time one scheduled pass may spend delivering before it hands the rest to the next pass. */
const PASS_BUDGET_MS = 45_000;

/**
 * Runs the API as a serverless function (Vercel). The same server as `index.ts`, built once per warm instance and fed
 * requests directly instead of listening on a port. There is no always-on process, so webhook deliveries and
 * housekeeping run when the scheduler calls GET /internal/cron/worker (set CRON_SECRET).
 */
export function createHandler(env: NodeJS.ProcessEnv = process.env) {
  let booting: Promise<FastifyInstance> | undefined;

  const boot = async (): Promise<FastifyInstance> => {
    const config = loadConfig({ ...env, RUN_WORKER_IN_API: 'false' });
    const db = createPool(config.DATABASE_URL, {
      max: config.DB_POOL_MAX,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
    });
    const dispatcher = new Dispatcher(db, {
      secretBox: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
      urlPolicy: { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE },
      consumers: allConsumers(),
    });
    const cron = env.CRON_SECRET
      ? {
          secret: env.CRON_SECRET,
          tick: async () => {
            const started = Date.now();
            let passes = 0;
            let handled = 0;
            while (Date.now() - started < PASS_BUDGET_MS) {
              const n = await dispatcher.runOnce();
              passes++;
              handled += n;
              if (!n) break;
            }
            await purgeIdempotencyKeys(db);
            await purgeDelivered(db);
            return { passes, handled };
          },
        }
      : undefined;
    const app = await buildServer({ config, db, cron });
    await app.ready();
    return app;
  };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      booting ??= boot().catch((err) => { booting = undefined; throw err; });
      const app = await booting;
      app.server.emit('request', req, res);
    } catch (err) {
      // A configuration or database problem at start-up. Say so plainly without leaking details.
      console.error('Mudatex API failed to start:', (err as Error).message);
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unavailable', message: 'The service is not configured correctly. Check the server logs.' }));
    }
  };
}

export default createHandler();
