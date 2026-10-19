import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export interface PoolOptions {
  max?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    statement_timeout: opts.statementTimeoutMs,
    idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs,
  });
  // An idle client dropping (database restart, network) must not crash the process.
  pool.on('error', (err) => console.error('Idle database client error:', err.message));
  return pool;
}

/** Runs fn in one transaction; commits on return, rolls back on throw. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}
