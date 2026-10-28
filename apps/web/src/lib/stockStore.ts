/** What the stock app keeps on the phone (IndexedDB): the downloaded stock list, a count in progress, and work waiting to be sent. */
import type { Sheet } from './stockSheet';

export interface DraftRow { variantId: string; lotId: string | null; counted: string }
export interface Draft { locationId: string; userId: string; rows: DraftRow[]; note: string }
export interface OutboxItem {
  /** Also the Idempotency-Key, so sending it twice can only ever record it once. */
  id: string; userId: string; kind: 'count' | 'receipt' | 'stock-receipt';
  path: string; body: unknown; label: string; createdAt: string;
  status: 'waiting' | 'rejected'; reason?: string;
}

const DB = 'mudatex-stock';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sheets', { keyPath: 'locationId' });
      db.createObjectStore('drafts', { keyPath: 'locationId' });
      db.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(req ? (req.result as T) : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export const saveSheet = (s: Sheet) => run('sheets', 'readwrite', (st) => st.put(s));
export const loadSheet = (locationId: string) => run<Sheet>('sheets', 'readonly', (st) => st.get(locationId));

export const saveDraft = (d: Draft) => run('drafts', 'readwrite', (st) => st.put(d));
export const loadDraft = (locationId: string) => run<Draft>('drafts', 'readonly', (st) => st.get(locationId));
export const clearDraft = (locationId: string) => run('drafts', 'readwrite', (st) => st.delete(locationId));

export const putOutbox = (i: OutboxItem) => run('outbox', 'readwrite', (st) => st.put(i));
export const removeOutbox = (id: string) => run('outbox', 'readwrite', (st) => st.delete(id));
export async function listOutbox(userId: string): Promise<OutboxItem[]> {
  const all = (await run<OutboxItem[]>('outbox', 'readonly', (st) => st.getAll())) ?? [];
  return all.filter((i) => i.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
