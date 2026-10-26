import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

export interface InitInput {
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
  callbackUrl: string;
}

export interface VerifyResult {
  /** The provider's word on the transaction: 'success' means money was taken. */
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amountMinor: number;
  currency: string;
  reference: string;
}

/** What the shop needs from a payment provider. The real one talks to Paystack; tests use a stand-in. */
export interface PaymentProvider {
  readonly name: 'paystack';
  initialize(input: InitInput): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<VerifyResult>;
  /** Sends money back to the card. `reference` is the original payment's. */
  refund(input: { reference: string; amountMinor: number }): Promise<{ providerRef: string; status: 'processed' | 'pending' }>;
}

export function createPaystack(secretKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.paystack.co'): PaymentProvider {
  const call = async (path: string, init?: RequestInit) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new AppError(502, 'payment_provider_unreachable', 'The payment service could not be reached. Please try again.');
    }
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: any };
    if (!res.ok || json.status === false) throw new AppError(502, 'payment_provider_error', 'The payment service could not process this request.');
    return json.data;
  };
  return {
    name: 'paystack',
    async initialize(i) {
      const data = await call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({ email: i.email, amount: i.amountMinor, currency: i.currency, reference: i.reference, callback_url: i.callbackUrl }),
      });
      if (!data?.authorization_url) throw new AppError(502, 'payment_provider_error', 'The payment service gave an unexpected answer.');
      return { authorizationUrl: data.authorization_url as string };
    },
    async verify(reference) {
      const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      const status = ['success', 'failed', 'abandoned'].includes(data?.status) ? data.status : 'pending';
      return { status, amountMinor: Number(data?.amount), currency: String(data?.currency ?? ''), reference: String(data?.reference ?? reference) };
    },
    async refund(i) {
      const data = await call('/refund', { method: 'POST', body: JSON.stringify({ transaction: i.reference, amount: i.amountMinor }) });
      if (!data?.id) throw new AppError(502, 'payment_provider_error', 'The payment service gave an unexpected answer.');
      return { providerRef: String(data.id), status: data.status === 'processed' ? 'processed' : 'pending' };
    },
  };
}

/** Paystack signs the exact bytes of a webhook body with HMAC-SHA512 and the secret key. */
export function validSignature(rawBody: Buffer | string, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
