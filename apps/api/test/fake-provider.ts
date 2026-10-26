import { AppError } from '../src/errors.js';
import type { PaymentProvider, VerifyResult } from '../src/payments/paystack.js';

/** A payment provider the tests control: what it says about a reference is whatever the test sets. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  initialized: { email: string; amountMinor: number; currency: string; reference: string; callbackUrl: string }[] = [];
  results = new Map<string, VerifyResult>();
  verifyCalls = 0;
  refunds: { reference: string; amountMinor: number }[] = [];
  refundStatus: 'processed' | 'pending' = 'pending';
  failRefund = false;
  async refund(i: { reference: string; amountMinor: number }) {
    if (this.failRefund) throw new AppError(502, 'payment_provider_error', 'provider down');
    this.refunds.push(i);
    return { providerRef: `RF${this.refunds.length}${Date.now()}`, status: this.refundStatus };
  }
  async initialize(i: (typeof this.initialized)[number]) {
    this.initialized.push(i);
    return { authorizationUrl: `https://checkout.paystack.test/${i.reference}` };
  }
  async verify(reference: string): Promise<VerifyResult> {
    this.verifyCalls++;
    return this.results.get(reference) ?? { status: 'pending', amountMinor: 0, currency: '', reference };
  }
  pay(reference: string, amountMinor: number, currency = 'NGN', status: VerifyResult['status'] = 'success') {
    this.results.set(reference, { status, amountMinor, currency, reference });
  }
}

