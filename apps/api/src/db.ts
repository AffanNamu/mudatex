import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export interface PoolOptions {
  max?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

/**
 * TLS for a hosted database. A hosted provider's connection usually needs its own certificate authority to be
 * verified; supply it as DATABASE_SSL_CA (PEM text, with "\n" accepted for line breaks). Without it, TLS follows the
 * `sslmode` in the connection string.
 */
export function sslFromEnv(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig['ssl'] {
  const ca = env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
  return ca ? { ca, rejectUnauthorized: true } : undefined;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: sslFromEnv(),
  });
  // Timeouts are set per connection with SET rather than as start-up parameters: poolers in front of hosted databases
  // (PgBouncer, Supavisor) may reject or ignore start-up parameters, and SET works behind a session-mode pooler.
  const settings = [
    opts.statementTimeoutMs ? `SET statement_timeout = ${Math.trunc(opts.statementTimeoutMs)}` : null,
    opts.idleInTransactionTimeoutMs ? `SET idle_in_transaction_session_timeout = ${Math.trunc(opts.idleInTransactionTimeoutMs)}` : null,
  ].filter(Boolean);
  if (settings.length) {
    pool.on('connect', (client) => {
      client.query(settings.join('; ')).catch((err: Error) => console.error('Could not apply database timeouts:', err.message));
    });
  }
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
