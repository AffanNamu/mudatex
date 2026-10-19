import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setOnUnauthorized, setToken } from './api';

const respond = (status: number, body?: unknown) => vi.fn().mockImplementation(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
afterEach(() => { vi.unstubAllGlobals(); setToken(null); setOnUnauthorized(() => {}); });

describe('api', () => {
  it('sends the token and the idempotency key, and parses the body', async () => {
    const f = respond(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    setToken('abc');
    expect(await api('/v1/x', { method: 'POST', body: { a: 1 }, idempotencyKey: 'k1' })).toEqual({ ok: 1 });
    const [, init] = f.mock.calls[0]!;
    expect(init.headers).toMatchObject({ authorization: 'Bearer abc', 'idempotency-key': 'k1', 'content-type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
  });

  it('turns server errors into ApiError with the server message', async () => {
    vi.stubGlobal('fetch', respond(409, { error: 'conflict', message: 'Register is inactive' }));
    await expect(api('/v1/x')).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'Register is inactive' });
  });

  it('signs the person out when a signed-in request is refused as unauthenticated, but not at the login form', async () => {
    const out = vi.fn();
    setOnUnauthorized(out);
    vi.stubGlobal('fetch', respond(401, { error: 'unauthorized', message: 'x' }));
    await expect(api('/v1/dev/token')).rejects.toBeInstanceOf(ApiError);
    expect(out).not.toHaveBeenCalled();
    setToken('t');
    await expect(api('/v1/me/grants')).rejects.toBeInstanceOf(ApiError);
    expect(out).toHaveBeenCalledOnce();
  });

  it('explains a network failure in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/v1/x')).rejects.toMatchObject({ status: 0, code: 'network', message: expect.stringContaining('Cannot reach the server') });
  });
});
