import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class UnsafeUrlError extends Error {}

function privateV4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    return privateV4(a, b);
  }
  const v = addr.toLowerCase();
  if (v === '::1' || v === '::') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

export interface UrlPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

/**
 * Webhook targets are chosen by customers, so they must not reach internal services (SSRF). The host is
 * resolved here and every address checked; the same check runs again at delivery to defeat DNS rebinding.
 */
export async function assertSafeUrl(raw: string, policy: UrlPolicy): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('Not a valid URL'); }
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) throw new UnsafeUrlError('Webhook URLs must use https');
  if (policy.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new UnsafeUrlError('Host does not resolve'); })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new UnsafeUrlError('Webhook URLs must not point at private or internal addresses');
  return url;
}
