import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, setOnUnauthorized, setToken } from './api';
import { listFactors, passwordSignIn, refreshDelay, refreshTokens, remoteSignOut, SignInError, supabaseConfigured, tokenAal, verifyTotp, type Tokens } from './identity';

export interface Scope { scope: 'group' | 'country' | 'legal_entity' | 'location'; id?: string; country?: string; role: string }
export interface Session {
  user: { id: string; email: string; displayName: string; organizationId: string };
  permissions: Record<string, Scope[]>;
  /** The deployment demands a second factor and this sign-in has none. */
  mfaRequired?: boolean;
}

/** Signed in with a password, but the second step is still to do. */
export type Pending = { kind: 'challenge'; factorId: string } | { kind: 'enrol' };

interface AuthValue {
  session: Session | null;
  loading: boolean;
  /** Set between the password and the second step; the person is not yet in. */
  pending: Pending | null;
  /** Checks the code from the authenticator app and completes sign-in. */
  verifyCode(code: string): Promise<void>;
  /** Call after a new authenticator app was verified: continues with the stronger session. */
  adoptVerified(t: Tokens): Promise<void>;
  /** The access token, for the setup screens that talk to the sign-in service directly. */
  accessToken(): string | null;
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
// The last profile the server gave us. A till that loses its connection and is reloaded can carry on from this;
// everything it then does is checked again by the server.
const PROFILE_KEY = 'mudatex.profile';
const readProfile = (): Session | null => { try { const v = sessionStorage.getItem(PROFILE_KEY); return v ? (JSON.parse(v) as Session) : null; } catch { return null; } };
const writeProfile = (p: Session | null) => { try { p ? sessionStorage.setItem(PROFILE_KEY, JSON.stringify(p)) : sessionStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ } };
const isNetwork = (e: unknown) => (e instanceof ApiError && e.status === 0) || (e instanceof SignInError && e.kind === 'network');
const write = (t: Tokens | null) => { try { t ? sessionStorage.setItem(KEY, JSON.stringify(t)) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable: stay signed in for this page only */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => read() !== null);
  const tokens = useRef<Tokens | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mode = supabaseConfigured() ? 'password' : 'dev';

  const signOut = useCallback(() => {
    clearTimeout(timer.current);
    const t = tokens.current;
    tokens.current = null;
    setToken(null); write(null); writeProfile(null); setSession(null); setPending(null);
    if (t && mode === 'password') void remoteSignOut(t.accessToken);
  }, [mode]);
  useEffect(() => { setOnUnauthorized(signOut); }, [signOut]);

  const adopt = useCallback((t: Tokens) => {
    tokens.current = t;
    setToken(t.accessToken); write(t);
    clearTimeout(timer.current);
    if (t.refreshToken) {
      const refresh = async () => {
        try { adopt(await refreshTokens(t.refreshToken!)); }
        catch (e) {
          // No connection is not the end of the session: try again shortly. Only a refusal ends it.
          if (isNetwork(e)) timer.current = setTimeout(refresh, 20_000); else signOut();
        }
      };
      timer.current = setTimeout(refresh, refreshDelay(t.expiresAt));
    }
  }, [signOut]);

  // After the password: a person with an authenticator app must prove it before anything loads, and a deployment that
  // demands one sends everyone else to set it up. Only a complete sign-in produces a session.
  const load = useCallback(async () => {
    const t = tokens.current;
    if (mode === 'password' && t && tokenAal(t.accessToken) !== 'aal2') {
      const verified = (await listFactors(t.accessToken)).find((f) => f.status === 'verified');
      if (verified) { setPending({ kind: 'challenge', factorId: verified.id }); return; }
    }
    const p = await api<Session>('/v1/me/grants');
    if (p.mfaRequired) { setPending({ kind: 'enrol' }); return; }
    setPending(null); writeProfile(p); setSession(p);
  }, [mode]);

  useEffect(() => {
    const t = read();
    if (!t) return;
    (async () => {
      let cur = t;
      if (cur.expiresAt <= Date.now() + 5_000) {
        if (!cur.refreshToken) throw new Error('expired');
        try { cur = await refreshTokens(cur.refreshToken); }
        catch (e) {
          // Reloaded with no connection: keep working from the last known profile; the token is refreshed once we are back.
          const cached = readProfile();
          if (isNetwork(e) && cached) { adopt(cur); setSession(cached); return; }
          throw e;
        }
      }
      adopt(cur);
      try { await load(); }
      catch (e) {
        const cached = readProfile();
        if (isNetwork(e) && cached) { setSession(cached); return; }
        throw e;
      }
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

  const verifyCode = useCallback(async (code: string) => {
    const t = tokens.current;
    if (!t || pending?.kind !== 'challenge') return;
    adopt(await verifyTotp(t.accessToken, pending.factorId, code));
    try { await load(); } catch (e) { signOut(); throw e; }
  }, [adopt, load, pending, signOut]);
  const adoptVerified = useCallback(async (t: Tokens) => {
    adopt(t);
    try { await load(); } catch (e) { signOut(); throw e; }
  }, [adopt, load, signOut]);
  const accessToken = useCallback(() => tokens.current?.accessToken ?? null, []);

  const value = useMemo<AuthValue>(() => ({
    session, loading, mode, signIn, signOut, pending, verifyCode, adoptVerified, accessToken,
    can: (p) => !!session?.permissions[p]?.length,
    canEverywhere: (p) => !!session?.permissions[p]?.some((s) => s.scope === 'group'),
  }), [session, loading, mode, signIn, signOut, pending, verifyCode, adoptVerified, accessToken]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
