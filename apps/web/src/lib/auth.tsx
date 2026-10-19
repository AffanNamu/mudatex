import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setOnUnauthorized, setToken } from './api';
import { passwordSignIn, refreshDelay, refreshTokens, remoteSignOut, supabaseConfigured, type Tokens } from './identity';

export interface Scope { scope: 'group' | 'country' | 'legal_entity' | 'location'; id?: string; country?: string; role: string }
export interface Session {
  user: { id: string; email: string; displayName: string; organizationId: string };
  permissions: Record<string, Scope[]>;
}

interface AuthValue {
  session: Session | null;
  loading: boolean;
  /** Which sign-in the form should offer. */
  mode: 'password' | 'dev';
  /** Password mode needs the password; the development sign-in ignores it. */
  signIn(email: string, password?: string): Promise<void>;
  signOut(): void;
  /** Holds the permission over at least one scope. The server still decides every request. */
  can(permission: string): boolean;
  /** Holds the permission over the whole organization. */
  canEverywhere(permission: string): boolean;
}

const Ctx = createContext<AuthValue | null>(null);
const KEY = 'mudatex.tokens';

const read = (): Tokens | null => { try { const v = sessionStorage.getItem(KEY); return v ? (JSON.parse(v) as Tokens) : null; } catch { return null; } };
const write = (t: Tokens | null) => { try { t ? sessionStorage.setItem(KEY, JSON.stringify(t)) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable: stay signed in for this page only */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => read() !== null);
  const tokens = useRef<Tokens | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mode = supabaseConfigured() ? 'password' : 'dev';

  const signOut = useCallback(() => {
    clearTimeout(timer.current);
    const t = tokens.current;
    tokens.current = null;
    setToken(null); write(null); setSession(null);
    if (t && mode === 'password') void remoteSignOut(t.accessToken);
  }, [mode]);
  useEffect(() => { setOnUnauthorized(signOut); }, [signOut]);

  const adopt = useCallback((t: Tokens) => {
    tokens.current = t;
    setToken(t.accessToken); write(t);
    clearTimeout(timer.current);
    if (t.refreshToken) {
      timer.current = setTimeout(async () => {
        try { adopt(await refreshTokens(t.refreshToken!)); } catch { signOut(); }
      }, refreshDelay(t.expiresAt));
    }
  }, [signOut]);

  const load = useCallback(async () => { setSession(await api<Session>('/v1/me/grants')); }, []);

  useEffect(() => {
    const t = read();
    if (!t) return;
    (async () => {
      let cur = t;
      if (cur.expiresAt <= Date.now() + 5_000) {
        if (!cur.refreshToken) throw new Error('expired');
        cur = await refreshTokens(cur.refreshToken);
      }
      adopt(cur);
      await load();
    })().catch(() => signOut()).finally(() => setLoading(false));
    return () => clearTimeout(timer.current);
  }, [adopt, load, signOut]);

  const signIn = useCallback(async (email: string, password?: string) => {
    if (mode === 'password') {
      adopt(await passwordSignIn(email, password ?? ''));
    } else {
      const r = await api<{ token: string }>('/v1/dev/token', { method: 'POST', body: { email } });
      adopt({ accessToken: r.token, refreshToken: null, expiresAt: Date.now() + 8 * 3600_000 });
    }
    try { await load(); } catch (e) { signOut(); throw e; }
  }, [adopt, load, mode, signOut]);

  const value = useMemo<AuthValue>(() => ({
    session, loading, mode, signIn, signOut,
    can: (p) => !!session?.permissions[p]?.length,
    canEverywhere: (p) => !!session?.permissions[p]?.some((s) => s.scope === 'group'),
  }), [session, loading, mode, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
