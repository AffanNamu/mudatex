// NEW: supabase/functions/paystack-webhook/index.ts. Set its URL as the webhook URL in the Paystack dashboard
// (Settings, API Keys & Webhooks) and deploy with --no-verify-jwt, because Paystack calls it, not a signed-in user.
// This is the only place an order becomes "paid". The app's return from the payment page proves nothing.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { commit, getDoc } from "../_shared/firebase.ts";
import { settle, verifyPaystackSignature, type Attempt, type PaystackTx } from "../_shared/logic.ts";

const reply = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

serve(async (req) => {
  if (req.method !== "POST") return reply(405);
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) return reply(500);

  const raw = await req.text();                                                    // the exact bytes that were signed
  if (!(await verifyPaystackSignature(raw, req.headers.get("x-paystack-signature"), secret))) return reply(401);

  let event: { event?: string; data?: { reference?: string } };
  try { event = JSON.parse(raw); } catch { return reply(400); }
  if (event.event !== "charge.success" || !event.data?.reference) return reply(200, { ignored: true });   // acknowledge other events
  const reference = event.data.reference;

  try {
    // Do not trust the webhook body for the amount: ask Paystack, then compare with what *we* said this reference must pay.
    const vres = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { authorization: `Bearer ${secret}` } });
    if (!vres.ok) return reply(502);   // Paystack will retry
    const tx = (await vres.json()).data as PaystackTx;

    const doc = await getDoc(`payment_attempts/${reference}`);
    const attempt = doc ? ({ ...doc, reference } as unknown as Attempt) : null;
    const verdict = settle(attempt, tx);

    if (!verdict.ok) {
      console.error("Payment not accepted", { reference, reason: verdict.reason });
      if (attempt && verdict.reason !== "reference_mismatch") {
        await commit([{ path: `payment_attempts/${reference}`, mustExist: true, set: { status: "rejected", rejectReason: verdict.reason, rejectedAtMs: Date.now() } }]);
      }
      return reply(200, { accepted: false });   // acknowledged so Paystack stops retrying; the attempt records why
    }
    if (verdict.alreadyDone) return reply(200, { accepted: true, duplicate: true });

    const paidNaira = attempt!.expectedAmountKobo / 100;
    try {
      await commit([
        // Created only if it does not exist, so a replayed webhook cannot create a second payment.
        { path: `payments/${reference}`, mustNotExist: true, set: {
          paymentId: reference, attemptId: reference, status: "success", provider: "paystack", providerTransactionId: reference,
          userId: attempt!.userId, orderId: attempt!.orderId, currency: attempt!.currency, amount: paidNaira, amountStr: paidNaira.toFixed(2),
          paidAtMs: Date.now(), createdAtMs: Date.now(), verification: { source: "paystack_webhook", verified: true },
        } },
        { path: `payment_attempts/${reference}`, mustExist: true, set: { status: "verified", verifiedAtMs: Date.now() } },
        { path: `orders/${attempt!.orderId}`, mustExist: true, set: { paymentStatus: "paid", status: "pending", paidAt: new Date().toISOString() } },
      ]);
    } catch (e) {
      if ((e as { conflict?: boolean }).conflict) return reply(200, { accepted: true, duplicate: true });
      throw e;
    }
    return reply(200, { accepted: true });
  } catch (err) {
    console.error("paystack-webhook failed", err instanceof Error ? err.message : err);
    return reply(500);   // Paystack retries on failure
  }
});
