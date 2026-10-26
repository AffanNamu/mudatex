import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Actor } from './auth/authorize.js';
import { createPaystack, type PaymentProvider } from './payments/paystack.js';
import { paystackWebhookRoutes } from './routes/webhooks-paystack.js';
import { createTokenVerifier, type TokenVerifier } from './auth/token.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { checkReadiness } from './readiness.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { accountingConfigRoutes } from './routes/accounting-config.js';
import { accountingReportRoutes } from './routes/accounting-reports.js';
import { postingRuleRoutes } from './routes/posting-rules.js';
import { journalRoutes } from './routes/journals.js';
import { createSecretBox } from './events/secretbox.js';
import { clientReadRoutes, devAuthRoutes } from './routes/client-reads.js';
import { integrationRoutes } from './routes/integrations.js';
import { catalogRoutes } from './routes/catalog.js';
import { iamRoutes } from './routes/iam.js';
import { inventoryAdjustmentRoutes } from './routes/inventory-adjustments.js';
import { inventoryReservationRoutes } from './routes/inventory-reservations.js';
import { inventoryStockRoutes } from './routes/inventory-stock.js';
import { inventoryTransferRoutes } from './routes/inventory-transfers.js';
import { orgRoutes } from './routes/org.js';
import { manufacturingMasterRoutes } from './routes/manufacturing-master.js';
import { manufacturingTraceRoutes } from './routes/manufacturing-trace.js';
import { workOrderRoutes } from './routes/work-orders.js';
import { purchaseOrderRoutes } from './routes/purchase-orders.js';
import { supplierRoutes } from './routes/suppliers.js';
import { posOfflineRoutes } from './routes/pos-offline.js';
import { posRegisterRoutes } from './routes/pos-registers.js';
import { posReturnRoutes } from './routes/pos-returns.js';
import { posSaleRoutes } from './routes/pos-sales.js';
import { pricingRoutes } from './routes/pricing.js';
import { enquiryRoutes } from './routes/enquiries.js';
import { tradeAccountRoutes } from './routes/trade-accounts.js';
import { demoRoutes } from './routes/demo.js';
import { reportRoutes } from './routes/reports.js';
import { reviewRoutes } from './routes/reviews.js';
import { salesOrderRoutes } from './routes/sales-orders.js';
import { shopCustomerRoutes } from './routes/shop-customer.js';
import { shopPublicRoutes } from './routes/shop-public.js';
import { storefrontAdminRoutes } from './routes/storefront-admin.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

/** A scheduled trigger for hosts with no always-on process (for example Vercel Cron calling this API once a minute). */
export interface CronDeps {
  secret: string;
  tick(): Promise<unknown>;
}

export interface ServerDeps {
  config: Config;
  db: Db;
  verifier?: TokenVerifier;
  /** Directory of SQL migrations the readiness check compares against the database. */
  migrationsDir?: string;
  cron?: CronDeps;
  /** Card payments. Defaults to Paystack when PAYSTACK_SECRET_KEY is set; tests pass a stand-in. */
  payments?: PaymentProvider;
  /** Hosts with no background worker: runs one delivery pass after each successful write, within a short time limit. */
  kick?: () => Promise<unknown>;
}

export async function buildServer({ config, db, verifier, migrationsDir, cron, payments: injected, kick }: ServerDeps): Promise<FastifyInstance> {
  const verify = verifier ?? createTokenVerifier(config);
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization'] },
    // Only well-formed client request ids are kept; anything else could be used to forge log lines.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomUUID();
    },
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: config.TRUST_PROXY,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['idempotent-replayed', 'x-request-id'],
    maxAge: 600,
  });
  const rateMax = config.RATE_LIMIT_MAX ?? (config.NODE_ENV === 'test' ? undefined : 600);
  if (rateMax) {
    // Applied as an app-level hook so it runs before authentication: unauthenticated requests are the ones to throttle.
    await app.register(rateLimit, { global: false, max: rateMax, timeWindow: '1 minute', allowList: (req) => req.url === '/health' || req.url === '/ready' });
    app.addHook('onRequest', app.rateLimit());
  }
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  if (kick) {
    app.addHook('onSend', async (req, reply, payload) => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400) {
        await Promise.race([kick().catch(() => undefined), new Promise((r) => setTimeout(r, 2500))]);
      }
      return payload;
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid request', issues: err.issues });
    }
    // Errors Fastify and its plugins raise for bad requests (malformed JSON, oversized body, rate limit) carry their own status.
    const fe = err as { statusCode?: number; code?: string };
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      const messages: Record<number, string> = { 400: 'Bad request', 413: 'Request body too large', 415: 'Unsupported media type', 429: 'Too many requests' };
      return reply.status(fe.statusCode).send({ error: fe.statusCode === 429 ? 'rate_limited' : 'bad_request', message: messages[fe.statusCode] ?? 'Bad request' });
    }
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505') {
      return reply.status(409).send({ error: 'conflict', message: `Already exists (${pg.constraint ?? 'unique'})` });
    }
    if (pg.code === '23503' || pg.code === '23514') {
      return reply.status(422).send({ error: 'invalid', message: `Constraint violated (${pg.constraint ?? 'check'})` });
    }
    if (process.env.DEBUG_ERRORS) console.error(err);
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  // Liveness: the process is up. Readiness: the database answers and every migration has been applied.
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const r = await checkReadiness(db, migrationsDir);
    return reply.status(r.ready ? 200 : 503).send(r);
  });

  if (cron) {
    // One delivery pass per call, for hosts that cannot keep a worker running. The scheduler proves itself with a shared secret.
    const expected = Buffer.from(`Bearer ${cron.secret}`);
    app.get('/internal/cron/worker', async (req, reply) => {
      const given = Buffer.from(req.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized();
      return reply.send({ ok: true, ...(await cron.tick() as object) });
    });
  }

  await app.register(devAuthRoutes, { db, config, prefix: '/v1' });

  // The customer-facing shop: public catalogue reads and signed-in shopper endpoints, apart from staff routes.
  const payments = injected ?? (config.PAYSTACK_SECRET_KEY ? createPaystack(config.PAYSTACK_SECRET_KEY, fetch, config.PAYSTACK_BASE_URL) : undefined);
  await app.register(shopPublicRoutes, { db, verify, cardPayments: !!payments });
  await app.register(shopCustomerRoutes, { db, verify, payments });
  if (payments && config.PAYSTACK_SECRET_KEY) await app.register(paystackWebhookRoutes, { db, provider: payments, secretKey: config.PAYSTACK_SECRET_KEY });

  await app.register(
    async (v1) => {
      v1.decorateRequest('actor', undefined as never);
      v1.addHook('onRequest', async (req: FastifyRequest) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) throw unauthorized();
        const { subject } = await verify(header.slice('Bearer '.length));
        const { rows } = await db.query<{ id: string; organization_id: string; status: string }>(
          'SELECT id, organization_id, status FROM users WHERE external_subject = $1',
          [subject],
        );
        const user = rows[0];
        if (!user) throw unauthorized('Unknown user');
        if (user.status !== 'active') throw forbidden('User is suspended');
        req.actor = { userId: user.id, organizationId: user.organization_id };
      });

      v1.get('/me', async (req) => req.actor);
      await v1.register(orgRoutes, { db });
      await v1.register(iamRoutes, { db });
      await v1.register(catalogRoutes, { db });
      await v1.register(inventoryStockRoutes, { db });
      await v1.register(inventoryReservationRoutes, { db });
      await v1.register(inventoryTransferRoutes, { db });
      await v1.register(inventoryAdjustmentRoutes, { db });
      await v1.register(pricingRoutes, { db });
      await v1.register(storefrontAdminRoutes, { db });
      await v1.register(salesOrderRoutes, { db, payments });
      await v1.register(enquiryRoutes, { db });
      await v1.register(reviewRoutes, { db });
      await v1.register(tradeAccountRoutes, { db });
      await v1.register(reportRoutes, { db });
      await v1.register(demoRoutes, { db });
      await v1.register(posRegisterRoutes, { db });
      await v1.register(posSaleRoutes, { db });
      await v1.register(posReturnRoutes, { db });
      await v1.register(posOfflineRoutes, { db });
      await v1.register(supplierRoutes, { db });
      await v1.register(purchaseOrderRoutes, { db });
      await v1.register(accountingConfigRoutes, { db });
      await v1.register(journalRoutes, { db });
      await v1.register(postingRuleRoutes, { db });
      await v1.register(clientReadRoutes, { db });
      await v1.register(accountingReportRoutes, { db });
      await v1.register(manufacturingMasterRoutes, { db });
      await v1.register(workOrderRoutes, { db });
      await v1.register(manufacturingTraceRoutes, { db });
      await v1.register(integrationRoutes, {
        db,
        secretBox: createSecretBox(config.SECRETS_ENCRYPTION_KEY),
        urlPolicy: { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE },
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
