/** The till's own small database, kept in the browser (IndexedDB) so unsent sales survive a closed tab or a dead battery. */

export interface PackItem {
  variantId: string; sku: string; name: string; unit: string; precision: number; unitKind: 'discrete' | 'decimal';
  unitPrice: string; taxCode: string | null; taxRate: string | null; taxInclusive: boolean; available: string; barcodes: string[];
}
export interface OfflinePack {
  registerId: string; userId: string;
  register: { id: string; code: string; name: string }; session: { id: string; openedAt: string } | null;
  currency: string; minorUnit: number; rules: { maxDiscountBps: number; mayDiscount: boolean; mayOverride: boolean };
  items: PackItem[]; version: string; generatedAt: string; validHours: number;
}
export interface QueuedLine { variantId: string; quantity: string; discountBps: number }
export interface QueuedSale {
  clientSaleId: string; registerId: string; sessionId: string; userId: string; soldAt: string; localReceiptNo: string; deviceId: string;
  lines: QueuedLine[]; tillTotalMinor: number; tenderedMinor: number;
  /** For the paper receipt and the screen only. The server prices the sale again. */
  display: { lines: { name: string; sku: string; quantity: string; unitPrice: string; totalMinor: number }[]; subtotalMinor: number; discountMinor: number; taxMinor: number; currency: string; minorUnit: number };
  status: 'waiting' | 'rejected'; reason?: string;
}
export interface SyncedReceipt { clientSaleId: string; localReceiptNo: string; receiptNumber: string; totalMinor: number; varianceMinor: number; at: string }

const DB = 'mudatex-till';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('packs', { keyPath: 'registerId' });
      db.createObjectStore('queue', { keyPath: 'clientSaleId' });
      db.createObjectStore('synced', { keyPath: 'clientSaleId' });
      db.createObjectStore('meta', { keyPath: 'key' });
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

export const savePack = (p: OfflinePack) => run('packs', 'readwrite', (s) => s.put(p));
export const loadPack = (registerId: string) => run<OfflinePack>('packs', 'readonly', (s) => s.get(registerId));
export async function listPacks(): Promise<OfflinePack[]> { return (await run<OfflinePack[]>('packs', 'readonly', (s) => s.getAll())) ?? []; }
export const clearPack = (registerId: string) => run('packs', 'readwrite', (s) => s.delete(registerId));

export const queueSale = (s: QueuedSale) => run('queue', 'readwrite', (st) => st.put(s));
export const updateQueued = (s: QueuedSale) => run('queue', 'readwrite', (st) => st.put(s));
export const removeQueued = (id: string) => run('queue', 'readwrite', (st) => st.delete(id));
export async function listQueue(registerId?: string): Promise<QueuedSale[]> {
  const all = (await run<QueuedSale[]>('queue', 'readonly', (s) => s.getAll())) ?? [];
  return all.filter((q) => !registerId || q.registerId === registerId).sort((a, b) => a.soldAt.localeCompare(b.soldAt));
}

export const saveSynced = (r: SyncedReceipt) => run('synced', 'readwrite', (s) => s.put(r));
export async function listSynced(): Promise<SyncedReceipt[]> {
  const all = (await run<SyncedReceipt[]>('synced', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}

/** A per-device counter for provisional receipt numbers, and a stable short id for this device. */
export async function nextLocalNumber(): Promise<{ deviceId: string; n: number }> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const s = tx.objectStore('meta');
    const getDevice = s.get('device');
    const getCounter = s.get('counter');
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
    getCounter.onsuccess = () => {
      const device = (getDevice.result?.value as string | undefined) ?? crypto.randomUUID().slice(0, 4).toUpperCase();
      const n = ((getCounter.result?.value as number | undefined) ?? 0) + 1;
      s.put({ key: 'device', value: device });
      s.put({ key: 'counter', value: n });
      resolve({ deviceId: device, n });
    };
  });
}

export const hoursOld = (iso: string, now = Date.now()) => (now - new Date(iso).getTime()) / 3_600_000;
export const packUsable = (p: OfflinePack | undefined, userId: string, now = Date.now()): p is OfflinePack =>
  !!p && !!p.session && p.userId === userId && hoursOld(p.generatedAt, now) < p.validHours;
