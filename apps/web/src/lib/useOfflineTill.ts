import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { listQueue, loadPack, nextLocalNumber, packUsable, queueSale, removeQueued, savePack, saveSynced, updateQueued, type OfflinePack, type QueuedLine, type QueuedSale, type PackItem } from './offlineStore';
import { priceLineLocal, sumLines } from './offlinePricing';

interface SyncResult { clientSaleId: string; status: 'created' | 'duplicate' | 'rejected'; receiptNumber?: string; totalMinor?: number; varianceMinor?: number; reason?: string }

const PACK_REFRESH_MS = 20 * 60_000;
const PROBE_MS = 8_000;

export interface OfflineLine { variantId: string; quantity: string; discountBps: number }

/** Price a cart from the pack. Returns what the till shows; the server prices again when the sale arrives. */
export function priceFromPack(pack: OfflinePack, queue: QueuedSale[], cart: OfflineLine[]) {
  const byId = new Map(pack.items.map((i) => [i.variantId, i]));
  const reserved = new Map<string, number>();
  for (const q of queue) for (const l of q.lines) reserved.set(l.variantId, (reserved.get(l.variantId) ?? 0) + Number(l.quantity));
  const problems: string[] = [];
  const lines = cart.map((c) => {
    const item = byId.get(c.variantId) as PackItem | undefined;
    if (!item) { problems.push('An item is not in the offline list'); return null; }
    if (c.discountBps > 0) {
      if (!pack.rules.mayDiscount) problems.push('You may not give discounts');
      else if (c.discountBps > pack.rules.maxDiscountBps && !pack.rules.mayOverride) problems.push(`Discount is above this register's limit of ${pack.rules.maxDiscountBps / 100}%`);
    }
    const p = priceLineLocal({ quantity: c.quantity, unitPrice: item.unitPrice, minorUnit: pack.minorUnit, discountBps: c.discountBps, taxRate: item.taxRate, taxInclusive: item.taxInclusive });
    const left = Number(item.available) - (reserved.get(c.variantId) ?? 0);
    return { item, p, quantity: c.quantity, discountBps: c.discountBps, available: Math.max(0, left), insufficientStock: Number(c.quantity) > left };
  });
  const priced = lines.filter((l): l is NonNullable<typeof l> => l !== null);
  const t = sumLines(priced.map((l) => l.p));
  return { lines: priced, ...t, problems: [...new Set(problems)] };
}

/**
 * Everything the till needs to keep selling cash when the line drops (ADR 002): connection state, the downloaded pack,
 * the queue of sales not yet sent, and sending them. Nothing here changes what an online till does.
 */
export function useOfflineTill(registerId: string, sessionId: string, userId: string) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pack, setPack] = useState<OfflinePack | undefined>();
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ sent: number; rejected: number } | null>(null);
  const syncingRef = useRef(false);

  const refreshQueue = useCallback(async () => setQueue(await listQueue(registerId)), [registerId]);

  // What is on the device already.
  useEffect(() => { void refreshQueue(); loadPack(registerId).then(setPack).catch(() => undefined); }, [registerId, refreshQueue]);

  const downloadPack = useCallback(async () => {
    try {
      const p = await api<Omit<OfflinePack, 'registerId' | 'userId'>>(`/v1/pos/registers/${registerId}/offline-pack`);
      const full: OfflinePack = { ...p, registerId, userId };
      await savePack(full);
      setPack(full);
    } catch (e) { if (e instanceof ApiError && e.status === 0) setOnline(false); }
  }, [registerId, userId]);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    const waiting = (await listQueue(registerId)).filter((q) => q.status === 'waiting');
    if (!waiting.length) return;
    syncingRef.current = true; setSyncing(true);
    let sent = 0; let rejected = 0;
    try {
      for (let i = 0; i < waiting.length; i += 25) {
        const batch = waiting.slice(i, i + 25);
        const res = await api<{ results: SyncResult[] }>('/v1/pos/offline-sales', {
          method: 'POST',
          body: { sales: batch.map((q) => ({
            clientSaleId: q.clientSaleId, registerId: q.registerId, sessionId: q.sessionId, soldAt: q.soldAt, deviceId: q.deviceId, localReceiptNo: q.localReceiptNo,
            lines: q.lines.map((l: QueuedLine) => ({ variantId: l.variantId, quantity: l.quantity, ...(l.discountBps ? { discount: { type: 'percent', basisPoints: l.discountBps } } : {}) })),
            tillTotalMinor: q.tillTotalMinor, tenderedMinor: q.tenderedMinor,
          })) },
        });
        for (const r of res.results) {
          const q = batch.find((b) => b.clientSaleId === r.clientSaleId);
          if (!q) continue;
          if (r.status === 'rejected') { rejected++; await updateQueued({ ...q, status: 'rejected', reason: r.reason }); }
          else {
            sent++;
            await saveSynced({ clientSaleId: q.clientSaleId, localReceiptNo: q.localReceiptNo, receiptNumber: r.receiptNumber!, totalMinor: r.totalMinor!, varianceMinor: r.varianceMinor ?? 0, at: new Date().toISOString() });
            await removeQueued(q.clientSaleId);
          }
        }
      }
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setOnline(false);
      else throw e;
    } finally {
      syncingRef.current = false; setSyncing(false); setLastSync({ sent, rejected }); await refreshQueue();
    }
  }, [registerId, refreshQueue]);

  // Browser connectivity events, plus a probe while we believe the line is down (the events are not always honest).
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(() => {
    if (online) return;
    const t = setInterval(() => { api('/health').then(() => setOnline(true)).catch(() => undefined); }, PROBE_MS);
    return () => clearInterval(t);
  }, [online]);

  // Back online: send what is waiting, and refresh the pack. While online, keep the pack fresh.
  useEffect(() => {
    if (!online) return;
    void sync().catch(() => undefined);
    void downloadPack();
    const t = setInterval(() => void downloadPack(), PACK_REFRESH_MS);
    return () => clearInterval(t);
  }, [online, sync, downloadPack]);

  /** Call when an online request failed for lack of a connection. */
  const connectionLost = useCallback(() => setOnline(false), []);

  const usable = packUsable(pack, userId) && pack.session?.id === sessionId;

  const sell = useCallback(async (cart: OfflineLine[], tenderedMinor: number): Promise<QueuedSale> => {
    if (!usable || !pack) throw new Error('This till has no offline price list yet. Reconnect once to download it.');
    const priced = priceFromPack(pack, queue, cart);
    if (priced.problems.length) throw new Error(priced.problems[0]);
    const { deviceId, n } = await nextLocalNumber();
    const sale: QueuedSale = {
      clientSaleId: crypto.randomUUID(), registerId, sessionId, userId, soldAt: new Date().toISOString(), deviceId: `${deviceId}`, localReceiptNo: `OFF-${deviceId}-${n}`,
      lines: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity, discountBps: c.discountBps })),
      tillTotalMinor: priced.total, tenderedMinor,
      display: {
        lines: priced.lines.map((l) => ({ name: l.item.name, sku: l.item.sku, quantity: l.quantity, unitPrice: l.item.unitPrice, totalMinor: l.p.total })),
        subtotalMinor: priced.subtotal, discountMinor: priced.discount, taxMinor: priced.tax, currency: pack.currency, minorUnit: pack.minorUnit,
      },
      status: 'waiting',
    };
    await queueSale(sale);
    await refreshQueue();
    return sale;
  }, [usable, pack, queue, registerId, sessionId, userId, refreshQueue]);

  const discard = useCallback(async (id: string) => { await removeQueued(id); await refreshQueue(); }, [refreshQueue]);

  return { online, setOnline, connectionLost, pack, usable, queue, waiting: queue.filter((q) => q.status === 'waiting'), rejected: queue.filter((q) => q.status === 'rejected'), syncing, lastSync, sync, sell, discard, downloadPack };
}
