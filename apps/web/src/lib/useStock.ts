import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { flushOutbox, enqueue, type Sent } from './stockOutbox';
import { listOutbox, loadSheet, saveSheet, type OutboxItem } from './stockStore';
import type { Sheet } from './stockSheet';

const KEY = 'mudatex-stock-location';
const remembered = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export interface StockLocation { id: string; name: string; type: string }
const HOLDS_STOCK = new Set(['branch', 'warehouse', 'storage_location']);

/**
 * The stock app's shared state: which place, that place's downloaded stock list, and the work waiting to be sent.
 * Counting and receiving always go through `submit`, which saves on the phone first and then tries to send.
 */
export function useStock(userId: string) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationState] = useState(remembered);
  const [sheet, setSheet] = useState<Sheet | undefined>();
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [sending, setSending] = useState(false);
  const [recent, setRecent] = useState<Sent[]>([]);
  const flushing = useRef(false);

  const setLocationId = useCallback((id: string) => { setLocationState(id); try { localStorage.setItem(KEY, id); } catch { /* optional */ } }, []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  useEffect(() => {
    api<StockLocation[]>('/v1/locations').then((all) => {
      const where = all.filter((l) => HOLDS_STOCK.has(l.type));
      setLocations(where);
      setLocationState((cur) => (where.some((l) => l.id === cur) ? cur : where[0]?.id ?? ''));
    }).catch(() => undefined);
  }, []);

  const refreshSheet = useCallback(async () => {
    if (!locationId) return;
    setSheetError(null);
    try {
      const fresh = await api<Sheet>(`/v1/inventory/count-sheet?locationId=${locationId}`);
      await saveSheet(fresh);
      setSheet(fresh);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0) setSheetError(e instanceof Error ? e.message : 'Could not load the stock list');
    }
  }, [locationId]);

  // The copy on the phone first (instant, works offline), then a fresh one when there is a connection.
  useEffect(() => {
    let live = true;
    setSheet(undefined);
    if (!locationId) return;
    loadSheet(locationId).then((s) => { if (live && s) setSheet(s); }).catch(() => undefined);
    if (navigator.onLine) void refreshSheet();
    return () => { live = false; };
  }, [locationId, refreshSheet]);

  const reloadOutbox = useCallback(async () => setOutbox(await listOutbox(userId)), [userId]);
  useEffect(() => { void reloadOutbox(); }, [reloadOutbox]);

  const flush = useCallback(async (): Promise<Sent[]> => {
    if (flushing.current) return [];
    flushing.current = true;
    setSending(true);
    try {
      const r = await flushOutbox(userId);
      await reloadOutbox();
      if (r.sent.length) { setRecent((cur) => [...r.sent, ...cur].slice(0, 20)); void refreshSheet(); }
      return r.sent;
    } catch { return []; }
    finally { flushing.current = false; setSending(false); }
  }, [userId, reloadOutbox, refreshSheet]);

  // Send whatever is waiting when the connection returns, and now and then while anything is still waiting.
  const waiting = outbox.filter((o) => o.status === 'waiting').length;
  useEffect(() => { if (online && waiting) void flush(); }, [online, waiting, flush]);
  useEffect(() => {
    if (!online || !waiting) return;
    const t = setInterval(() => void flush(), 30_000);
    return () => clearInterval(t);
  }, [online, waiting, flush]);

  const submit = useCallback(async (item: Omit<OutboxItem, 'id' | 'createdAt' | 'status' | 'userId'>) => {
    const queued = await enqueue({ ...item, userId });
    await reloadOutbox();
    void flush();
    return queued;
  }, [userId, reloadOutbox, flush]);

  const location = useMemo(() => locations.find((l) => l.id === locationId), [locations, locationId]);
  return { online, locations, locationId, location, setLocationId, sheet, sheetError, refreshSheet, outbox, waiting, sending, recent, flush, reloadOutbox, submit };
}

export type Stock = ReturnType<typeof useStock>;
