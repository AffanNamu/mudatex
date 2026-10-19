import type { Db } from '../db.js';

/** Idempotency keys only need to outlive client retries. */
export async function purgeIdempotencyKeys(db: Db, olderThanDays = 7): Promise<number> {
  const r = await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(days => $1)`, [olderThanDays]);
  return r.rowCount ?? 0;
}

/** Delivered attempts are history, not state. Events and dead letters are kept. */
export async function purgeDelivered(db: Db, olderThanDays = 30): Promise<number> {
  const r = await db.query(`DELETE FROM event_deliveries WHERE status = 'delivered' AND delivered_at < now() - make_interval(days => $1)`, [olderThanDays]);
  return r.rowCount ?? 0;
}
