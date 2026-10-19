import type { Db } from '../db.js';
import { Dispatcher, type DispatcherOptions } from './dispatcher.js';
import { purgeDelivered, purgeIdempotencyKeys } from './maintenance.js';

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Polls the outbox. Several workers may run at once; the database arbitrates with SKIP LOCKED. */
export function startWorker(db: Db, opts: DispatcherOptions & { pollMs: number }): WorkerHandle {
  const dispatcher = new Dispatcher(db, opts);
  let stopped = false;
  let lastMaintenance = 0;
  const log = opts.log ?? ((m: string, x?: unknown) => console.error(m, x ?? ''));

  const loop = (async () => {
    while (!stopped) {
      let busy = 0;
      try {
        busy = await dispatcher.runOnce();
        if (Date.now() - lastMaintenance > 3600_000) {
          lastMaintenance = Date.now();
          await purgeIdempotencyKeys(db);
          await purgeDelivered(db);
        }
      } catch (err) {
        log('worker pass failed', (err as Error).message);
      }
      if (!busy && !stopped) await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  })();

  return { stop: async () => { stopped = true; await loop; } };
}
