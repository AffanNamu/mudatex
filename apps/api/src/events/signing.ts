import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signature header value: `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. */
export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** What a receiver does: recompute, compare in constant time, and reject stale timestamps to stop replays. */
export function verifySignature(secret: string, body: string, header: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
