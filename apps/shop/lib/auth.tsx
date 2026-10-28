'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, shopRequest } from './api';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import { hasChosenLang, tr, useI18n } from './i18n';
import type { Customer } from './types';

interface Session { accessToken: string; refreshToken: string; expiresAt: number }

type ProfileState = 'loading' | 'ready' | 'needed';

interface AuthValue {
  ready: boolean;
  signedIn: boolean;
  email: string | null;
  token: string | null;
  customer: Customer | null;
  profile: ProfileState;
  configured: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<'signed-in' | 'confirm-email'>;
  recover(email: string): Promise<void>;
  signOut(): void;
  createProfile(input: { fullName: string; phone?: string; marketingOptIn?: boolean; language?: string }): Promise<void>;
  updateProfile(input: { fullName: string; phone?: string | null; marketingOptIn?: boolean; smsOptIn?: boolean; language?: string }): Promise<void>;
}

const STORAGE_KEY = 'mudatex.shopper';
const Ctx = createContext<AuthValue | null>(null);

async function identity(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = String(json.msg ?? json.error_description ?? json.message ?? '');
    throw new Error(/invalid login/i.test(raw) ? tr('auth.invalid') : /already registered/i.test(raw) ? tr('auth.exists') : raw || tr('auth.generic'));
  }
  return json;
}

const toSession = (j: any): Session => ({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 });
const emailOf = (token: string): string | null => {
  try {
    return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).email ?? null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [profile, setProfile] = useState<ProfileState>('loading');
  const refreshing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { lang, setLang } = useI18n();
  const pushedLang = useRef<string | null>(null);

  const store = useCallback((s: Session | null) => {
    setSession(s);
    try {
      if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* private mode: the session simply lasts until the tab closes */ }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSession(JSON.parse(raw) as Session);
    } catch { /* ignore */ }
    setReady(true);
  }, []);

  // Keep the access token fresh a minute before it expires.
  useEffect(() => {
    if (!session) return;
    clearTimeout(refreshing.current);
    const wait = Math.max(0, session.expiresAt - Date.now() - 60_000);
    refreshing.current = setTimeout(async () => {
      try {
        store(toSession(await identity('token?grant_type=refresh_token', { refresh_token: session.refreshToken })));
      } catch {
        store(null);
      }
    }, wait);
    return () => clearTimeout(refreshing.current);
  }, [session, store]);

  const token = session?.accessToken ?? null;
  useEffect(() => {
    if (!token) {
      setCustomer(null);
      setProfile('loading');
      return;
    }
    let cancelled = false;
    shopRequest<Customer>('/me', { token })
      .then((c) => { if (!cancelled) { setCustomer(c); setProfile('ready'); } })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) { setCustomer(null); setProfile('needed'); }
        else if (err instanceof ApiError && err.status === 401) store(null);
      });
    return () => { cancelled = true; };
  }, [token, store]);

  // Emails and notifications follow the shopper's language. A device with no choice of its own adopts the account's;
  // a device with a choice tells the account.
  useEffect(() => {
    if (!customer || !token) return;
    const saved = customer.language ?? 'en';
    if (!hasChosenLang()) { if (saved !== lang) setLang(saved); return; }
    if (saved !== lang && pushedLang.current !== lang) {
      pushedLang.current = lang;
      shopRequest('/me/language', { method: 'PUT', token, body: { language: lang } }).catch(() => { pushedLang.current = null; });
    }
  }, [customer, token, lang, setLang]);

  const value = useMemo<AuthValue>(() => ({
    ready,
    signedIn: !!session,
    email: token ? emailOf(token) : null,
    token,
    customer,
    profile,
    configured: !!SUPABASE_URL && !!SUPABASE_KEY,
    async signIn(email, password) {
      store(toSession(await identity('token?grant_type=password', { email, password })));
    },
    async signUp(email, password) {
      const j = await identity('signup', { email, password });
      if (j.access_token) { store(toSession(j)); return 'signed-in'; }
      return 'confirm-email';
    },
    async recover(email) {
      await identity('recover', { email });
    },
    signOut() { store(null); },
    async createProfile(input) {
      if (!token) throw new Error(tr('auth.signInFirst'));
      setCustomer(await shopRequest<Customer>('/me', { method: 'POST', body: input, token }));
      setProfile('ready');
    },
    async updateProfile(input) {
      if (!token) throw new Error(tr('auth.signInFirst'));
      setCustomer(await shopRequest<Customer>('/me', { method: 'PUT', body: input, token }));
    },
  }), [ready, session, token, customer, profile, store]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
