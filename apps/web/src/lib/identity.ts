/**
 * Sign-in with Supabase Auth over its public REST API (no SDK, no cookies). The API verifies the access token against
 * the project's published keys; nothing here is trusted by the server.
 *
 * Configuration comes from config.js (set when the container starts): supabaseUrl and supabaseKey (the project's
 * publishable "anon" key, which is designed to be public). With neither set the console offers the development sign-in.
 */
declare global { interface Window { __MUDATEX__?: { apiUrl?: string; supabaseUrl?: string; supabaseKey?: string } } }

export interface Tokens { accessToken: string; refreshToken: string | null; /** epoch milliseconds */ expiresAt: number }

const cfg = () => window.__MUDATEX__ ?? {};
export const supabaseConfigured = () => !!(cfg().supabaseUrl && cfg().supabaseKey);
const base = () => `${cfg().supabaseUrl!.replace(/\/$/, '')}/auth/v1`;

export class SignInError extends Error {
  constructor(readonly kind: 'credentials' | 'unconfirmed' | 'rate_limited' | 'network' | 'other', message: string) { super(message); }
}

async function call(path: string, body: unknown, accessToken?: string): Promise<Response> {
  try {
    return await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg().supabaseKey!, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignInError('network', 'Cannot reach the sign-in service. Check your connection and try again.');
  }
}

function toTokens(j: { access_token?: string; refresh_token?: string; expires_in?: number }, now = Date.now()): Tokens {
  if (!j.access_token || typeof j.expires_in !== 'number') throw new SignInError('other', 'The sign-in service sent an unexpected reply.');
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: now + j.expires_in * 1000 };
}

export async function passwordSignIn(email: string, password: string): Promise<Tokens> {
  const res = await call('/token?grant_type=password', { email, password });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return toTokens(j);
  const code = String(j.error_code ?? j.code ?? '');
  if (res.status === 429 || code === 'over_request_rate_limit') throw new SignInError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  if (code === 'email_not_confirmed') throw new SignInError('unconfirmed', 'Confirm your email address first, using the link we sent you.');
  if (code === 'invalid_credentials' || res.status === 400) throw new SignInError('credentials', 'Wrong email or password.');
  throw new SignInError('other', 'Sign-in failed. Try again, or ask an administrator.');
}

export async function refreshTokens(refreshToken: string): Promise<Tokens> {
  const res = await call('/token?grant_type=refresh_token', { refresh_token: refreshToken });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new SignInError('credentials', 'Your session has ended. Sign in again.');
  return toTokens(j);
}

export async function remoteSignOut(accessToken: string): Promise<void> {
  try { await call('/logout', {}, accessToken); } catch { /* the local session is cleared regardless */ }
}

/** Email a password-reset link. Always reports success so the form cannot be used to discover who has an account. */
export async function requestPasswordReset(email: string): Promise<void> {
  try { await call('/recover', { email }); } catch { /* same reply either way */ }
}

/** When to refresh: a minute before expiry, or halfway through a very short life. */
export const refreshDelay = (expiresAt: number, now = Date.now()) => Math.max(0, expiresAt - now - Math.min(60_000, (expiresAt - now) / 2));

/** The one-time token in a password-reset or invitation link (`#access_token=…&type=recovery`), or null. */
export function linkTokenFromHash(hash: string): string | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const type = p.get('type');
  const token = p.get('access_token');
  return token && (type === 'recovery' || type === 'invite') ? token : null;
}

export async function setNewPassword(linkToken: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base()}/user`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', apikey: cfg().supabaseKey!, authorization: `Bearer ${linkToken}` },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new SignInError('network', 'Cannot reach the sign-in service. Check your connection and try again.');
  }
  if (res.ok) return;
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new SignInError('credentials', 'This link has expired or was already used. Request a new one from the sign-in page.');
  throw new SignInError('other', typeof j.msg === 'string' ? j.msg : 'The new password was not accepted. Try a longer one.');
}
