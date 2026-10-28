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

// ---- Second factor (authenticator app) ------------------------------------------------------------------------------

export interface Factor { id: string; status: 'verified' | 'unverified'; friendlyName: string | null }
export interface TotpEnrolment { factorId: string; qrCode: string; secret: string }

/** Which assurance level a token carries ('aal2' once a second factor was verified). Read for the screen only; the server checks it for real. */
export function tokenAal(accessToken: string): 'aal1' | 'aal2' | null {
  try {
    const part = accessToken.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return json.aal === 'aal2' ? 'aal2' : json.aal === 'aal1' ? 'aal1' : null;
  } catch { return null; }
}

async function authed(method: 'GET' | 'POST' | 'DELETE', path: string, accessToken: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${base()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', apikey: cfg().supabaseKey!, authorization: `Bearer ${accessToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new SignInError('network', 'Cannot reach the sign-in service. Check your connection and try again.');
  }
}

/** The authenticator apps this person has set up (only the verified ones count). */
export async function listFactors(accessToken: string): Promise<Factor[]> {
  const res = await authed('GET', '/user', accessToken);
  if (!res.ok) throw new SignInError('other', 'Could not check your two-step sign-in. Try again.');
  const j = await res.json().catch(() => ({}));
  return (Array.isArray(j.factors) ? j.factors : [])
    .filter((f: { factor_type?: string }) => f.factor_type === 'totp')
    .map((f: { id: string; status: string; friendly_name?: string | null }) => ({ id: f.id, status: f.status === 'verified' ? 'verified' : 'unverified', friendlyName: f.friendly_name ?? null }));
}

/** Starts setting up an authenticator app: returns the QR code and the secret to type in by hand. Not active until a code is verified. */
export async function enrollTotp(accessToken: string, name = `Authenticator ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`): Promise<TotpEnrolment> {
  const res = await authed('POST', '/factors', accessToken, { factor_type: 'totp', friendly_name: name, issuer: 'Mudatex' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id || !j.totp) throw new SignInError('other', 'Could not start setting up two-step sign-in. Try again.');
  return { factorId: j.id, qrCode: j.totp.qr_code, secret: j.totp.secret };
}

/** Proves possession of the authenticator app. Returns a new session that carries the second factor. */
export async function verifyTotp(accessToken: string, factorId: string, code: string): Promise<Tokens> {
  const ch = await authed('POST', `/factors/${factorId}/challenge`, accessToken, {});
  const cj = await ch.json().catch(() => ({}));
  if (!ch.ok || !cj.id) throw new SignInError(ch.status === 429 ? 'rate_limited' : 'other', ch.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Could not check the code. Try again.');
  const res = await authed('POST', `/factors/${factorId}/verify`, accessToken, { challenge_id: cj.id, code: code.replace(/\s/g, '') });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return toTokens(j);
  if (res.status === 429) throw new SignInError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  throw new SignInError('credentials', 'That code is not right, or it has expired. Enter the newest code from your app.');
}

export async function removeFactor(accessToken: string, factorId: string): Promise<void> {
  const res = await authed('DELETE', `/factors/${factorId}`, accessToken);
  if (!res.ok) throw new SignInError('other', 'Could not remove it. Sign in again with your code, then retry.');
}
