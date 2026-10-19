import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setOnUnauthorized, setToken } from './api';

export interface Scope { scope: 'group' | 'country' | 'legal_entity' | 'location'; id?: string; country?: string; role: string }
export interface Session {
  user: { id: string; email: string; displayName: string; organizationId: string };
  permissions: Record<string, Scope[]>;
}

interface AuthValue {
  session: Session | null;
  loading: boolean;
  /** Development sign-in: exchanges an email for a token. Real identity-provider sign-in is not wired yet. */
  signIn(email: string): Promise<void>;
  signOut(): void;
  /** Holds the permission over at least one scope. The server still decides every request. */
  can(permission: string): boolean;
  /** Holds the permission over the whole organization. */
  canEverywhere(permission: string): boolean;
}

const Ctx = createContext<AuthValue | null>(null);
const KEY = 'mudatex.token';

const read = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const write = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable: stay signed in for this page only */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => read() !== null);

  const signOut = useCallback(() => { setToken(null); write(null); setSession(null); }, []);
  useEffect(() => { setOnUnauthorized(signOut); }, [signOut]);

  const load = useCallback(async () => {
    setSession(await api<Session>('/v1/me/grants'));
  }, []);

  useEffect(() => {
    const t = read();
    if (!t) return;
    setToken(t);
    load().catch(() => signOut()).finally(() => setLoading(false));
  }, [load, signOut]);

  const signIn = useCallback(async (email: string) => {
    const r = await api<{ token: string }>('/v1/dev/token', { method: 'POST', body: { email } });
    setToken(r.token);
    write(r.token);
    try { await load(); } catch (e) { signOut(); throw e; }
  }, [load, signOut]);

  const value = useMemo<AuthValue>(() => ({
    session, loading, signIn, signOut,
    can: (p) => !!session?.permissions[p]?.length,
    canEverywhere: (p) => !!session?.permissions[p]?.some((s) => s.scope === 'group'),
  }), [session, loading, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
