import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Actor } from './auth/authorize.js';
import { createTokenVerifier, type TokenVerifier } from './auth/token.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { accountingConfigRoutes } from './routes/accounting-config.js';
import { accountingReportRoutes } from './routes/accounting-reports.js';
import { journalRoutes } from './routes/journals.js';
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
import { posRegisterRoutes } from './routes/pos-registers.js';
import { posReturnRoutes } from './routes/pos-returns.js';
import { posSaleRoutes } from './routes/pos-sales.js';
import { pricingRoutes } from './routes/pricing.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

export interface ServerDeps {
  config: Config;
  db: Db;
  verifier?: TokenVerifier;
}

export async function buildServer({ config, db, verifier }: ServerDeps): Promise<FastifyInstance> {
  const verify = verifier ?? createTokenVerifier(config);
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid request', issues: err.issues });
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

  app.get('/health', async () => ({ status: 'ok' }));

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
      await v1.register(posRegisterRoutes, { db });
      await v1.register(posSaleRoutes, { db });
      await v1.register(posReturnRoutes, { db });
      await v1.register(supplierRoutes, { db });
      await v1.register(purchaseOrderRoutes, { db });
      await v1.register(accountingConfigRoutes, { db });
      await v1.register(journalRoutes, { db });
      await v1.register(accountingReportRoutes, { db });
      await v1.register(manufacturingMasterRoutes, { db });
      await v1.register(workOrderRoutes, { db });
      await v1.register(manufacturingTraceRoutes, { db });
    },
    { prefix: '/v1' },
  );

  return app;
}
