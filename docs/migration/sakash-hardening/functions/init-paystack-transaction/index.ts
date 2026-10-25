// REPLACES supabase/functions/init-paystack-transaction/index.ts.
// Starts a Paystack payment for an order that already exists in Firestore with status "awaiting_payment".
// The caller proves who they are with their Firebase ID token (no shared secret in the app), names only the order,
// and the amount charged is computed here from prices read from Firestore. The app can no longer choose what it pays.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { commit, getDoc, verifyIdToken } from "../_shared/firebase.ts";
import { PricingError, priceOrder, type OrderLine, type ProductRecord } from "../_shared/logic.ts";

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!bearer) return json({ error: "Sign in first" }, 401);
    let user: { uid: string; email: string };
    try { user = await verifyIdToken(bearer); } catch { return json({ error: "Sign in again" }, 401); }

    const { orderId } = (await req.json()) as { orderId?: string };
    if (!orderId || !/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) return json({ error: "orderId is required" }, 400);

    const order = await getDoc(`orders/${orderId}`);
    // One answer for "does not exist" and "belongs to someone else", so order ids cannot be probed.
    if (!order || order.userId !== user.uid) return json({ error: "Order not found" }, 404);
    if (order.status !== "awaiting_payment" || order.paymentStatus !== "unpaid") return json({ error: "This order is not waiting for payment" }, 409);

    const lines = ((order.items as Array<Record<string, unknown>>) ?? []).map((i) => ({ productId: String(i.productId ?? ""), qty: Number(i.qty ?? 0) })) as OrderLine[];
    const products = new Map<string, ProductRecord | null>();
    for (const l of lines) {
      const p = await getDoc(`products/${l.productId}`);
      products.set(l.productId, p ? { price: Number(p.price), promoDiscountPercent: Number(p.promoDiscountPercent ?? 0), stockQuantity: p.stockQuantity === undefined ? undefined : Number(p.stockQuantity) } : null);
    }
    const settings = (await getDoc("app_settings/general")) ?? {};
    const priced = priceOrder({
      lines, products,
      couponCode: typeof order.couponCode === "string" ? order.couponCode : "",
      deliveryFeeNaira: Number(order.deliveryFee ?? 0),
      maxDeliveryFeeNaira: Number(settings.maxDeliveryFee ?? 50_000),
    });

    const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!secret) return json({ error: "Payments are not configured" }, 500);
    const reference = `SAK_${crypto.randomUUID().replaceAll("-", "")}`;   // unguessable, unique per attempt

    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, amount: priced.totalKobo, currency: "NGN", reference, metadata: { orderId, uid: user.uid } }),
    });
    if (!res.ok) { console.error("Paystack initialize failed", res.status); return json({ error: "Could not start the payment" }, 502); }
    const decoded = await res.json();

    // Server-side record of what this reference must pay. Clients cannot write here (see firestore.rules.hardened).
    await commit([
      { path: `payment_attempts/${reference}`, mustNotExist: true, set: { reference, status: "initialized", userId: user.uid, orderId, expectedAmountKobo: priced.totalKobo, currency: "NGN", createdAtMs: Date.now() } },
      { path: `orders/${orderId}`, mustExist: true, set: { paymentReference: reference, itemsSubtotal: priced.itemsKobo / 100, couponDiscount: priced.couponKobo / 100, totalAmount: priced.totalKobo / 100 } },
    ]);

    return json({ success: true, reference, authorizationUrl: decoded.data?.authorization_url ?? "", totalNaira: priced.totalKobo / 100 });
  } catch (err) {
    if (err instanceof PricingError) return json({ error: err.message }, 422);
    console.error("init-paystack-transaction failed", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong" }, 500);
  }
});
