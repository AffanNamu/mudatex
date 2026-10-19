import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

export interface Loaded<T> { data: T | undefined; error: ApiError | null; loading: boolean; reload(): void }

/** Loads a GET once, and again on demand. Aborts when the page changes. A null path means "not yet". */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) { setData(undefined); setLoading(false); return; }
    const ac = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ac.signal })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Debounces a changing value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** The latest value, for callbacks that must not go stale. */
export function useLatest<T>(value: T) {
  const r = useRef(value);
  r.current = value;
  return r;
}
