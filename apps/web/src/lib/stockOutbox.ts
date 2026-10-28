import { api, ApiError } from './api';
import { listOutbox, putOutbox, removeOutbox, type OutboxItem } from './stockStore';

export interface Sent { item: OutboxItem; response: unknown }

/**
 * Sends what is waiting, oldest first. A lost connection stops the run and leaves everything in place; a refusal from the
 * server (the count is too old, an order is closed…) marks that one item so a person can read why and discard it.
 * Every item carries its own Idempotency-Key, so a reply lost on the way back never causes a second posting.
 */
export async function flushOutbox(userId: string): Promise<{ sent: Sent[]; rejected: number; stopped: 'offline' | 'signed-out' | null }> {
  const sent: Sent[] = [];
  let rejected = 0;
  for (const item of await listOutbox(userId)) {
    if (item.status === 'rejected') { rejected++; continue; }
    try {
      const response = await api(item.path, { method: 'POST', body: item.body, idempotencyKey: item.id });
      await removeOutbox(item.id);
      sent.push({ item, response });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 0 || e.status >= 500 || e.status === 429) return { sent, rejected, stopped: 'offline' };
      if (e.status === 401) return { sent, rejected, stopped: 'signed-out' };
      await putOutbox({ ...item, status: 'rejected', reason: e.message });
      rejected++;
    }
  }
  return { sent, rejected, stopped: null };
}

export async function enqueue(item: Omit<OutboxItem, 'id' | 'createdAt' | 'status'>): Promise<OutboxItem> {
  const full: OutboxItem = { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'waiting' };
  await putOutbox(full);
  return full;
}
