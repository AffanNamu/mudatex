# Sakash payment hardening: what was found in the code, and a tested fix

**Status:** Proposed. Nothing in the live Sakash project or the `AffanNamu/PFB` repository has been changed. The server
logic here is tested (7 tests, `logic.test.ts`); the Firebase/Paystack plumbing and the Flutter changes are **not**, because
they need your live projects and a Flutter toolchain. Try everything on Paystack **test** keys first.

Read at `AffanNamu/PFB` commit `a52d3bd` (13 Oct 2026). This replaces the "what the rules allow" guesses in
`../SAKASH_PAYMENT_SECURITY.md` with what the code actually does.

## What the code does (confirmed)

| # | Where | Finding | Consequence |
|---|---|---|---|
| 1 | `paystack_verification_screen.dart` 31 to 66; `payment_service.dart` 356 | The "I have paid" button only checks that a `payment_attempts` document exists, then calls `confirmManualPaymentSuccess`, which writes a payment record marked `verified: true` ("Manually confirmed after Paystack return") and **never asks Paystack**. | A customer can start checkout, never pay, tap the button, and get a paid order. |
| 2 | `firebase_service.dart` 1541 `placeOrder` | `paymentStatus` defaults to `'paid'`; the screen calls `placeOrder(session.items)` with no reference, coupon or delivery fee. The order total is computed from the **prices in the cart items** (client data). | Orders are stamped paid regardless; the stored total ignores delivery and coupon; orders cannot be matched to payments (empty reference). |
| 3 | `init-paystack-transaction/index.ts` 38 to 61 | The function trusts any caller holding one shared secret and any `amountNaira` they send. It never looks at an order. The secret is a compile-time constant in the app (`app_constants.dart` 75) and the comparison is not constant-time. | Anyone who extracts the secret from the app can start payments for any amount and any reference, and a customer can pay ₦1 for a ₦100,000 cart. |
| 4 | `cart_screen.dart` 225 to 255, 454 to 458 | Coupons `PF10` (10%) and `ANKARA20` (20%) are checked in the app, with no limit, expiry or per-user rule. Delivery fee and grand total are computed in the app and sent to Paystack. | Discounts are public; totals can be altered on a modified client. |
| 5 | Repository root | Committed: `android/app/upload-keystore.jks`, `upload-keystore.jks`, `android/key.properties`, `keystore.base64`, `keystore_base64.txt`, `debug.keystore`, `gsj.txt`, `android/app/google-services.json`, plus the shared function secret and the Supabase anon key inside `app_constants.dart`. | The Play upload signing key is public. See "Secrets" below. |
| 6 | Firestore rules (supplied sample) | See `../SAKASH_PAYMENT_SECURITY.md` rows 1 to 8. | Clients may write `payments`, `payment_attempts` and notifications. |

No live Paystack secret key is committed (the deployment guide holds a placeholder). The FCM function reads its private
key from the environment.

## The fix

```
functions/_shared/logic.ts        pricing, signature check, settlement decision (pure, tested)
functions/_shared/firestore.ts    Firestore REST value encoding (pure, tested)
functions/_shared/firebase.ts     Firebase ID-token check, service-account access, reads and atomic writes (needs a live project)
functions/init-paystack-transaction/index.ts   REPLACES the existing function
functions/paystack-webhook/index.ts            NEW: the only thing that can mark an order paid
app/APP_CHANGES.md                the Flutter changes, with code
firestore.rules.hardened          the rules to apply last
logic.test.ts                     the tests
```

How a payment works afterwards:

1. The app creates an order with status `awaiting_payment`, `paymentStatus: unpaid`, and product ids and quantities only.
2. The app calls `init-paystack-transaction` with its **Firebase sign-in token** and the order id. The function checks the
   order is the caller's and unpaid, reads prices from `products`, applies the coupon it recognises and a delivery fee
   within a ceiling, and asks Paystack to charge **that** amount under an unguessable reference. It records what the
   reference must pay in `payment_attempts`.
3. The customer pays on Paystack. Paystack calls `paystack-webhook`.
4. The webhook checks Paystack's signature, asks Paystack to confirm the transaction, and accepts only if the reference is
   known, the status is success, the currency matches and the amount **equals what the server recorded**. Then, in one
   atomic write, it creates the payment (refusing if one already exists), marks the attempt verified and the order paid. A
   replay is acknowledged and ignored; a mismatch is recorded with its reason.
5. The app only watches the order until it turns paid.

Tests cover: pricing in integer kobo with promotions, coupons and delivery; every tampering case (zero or fractional
quantity, duplicate lines, missing product, unknown coupon, negative or huge delivery fee, no stock, bad price or promotion);
the signature check (altered body, wrong secret, truncated or missing signature); every settlement mismatch, including
paying ₦1 for a larger order and a replayed webhook.

## Rollout order (do not reorder)

1. **Now, no app change:** reconcile a sample period against Paystack and your bank; rotate secrets (below).
2. Deploy the two functions (`supabase functions deploy init-paystack-transaction --no-verify-jwt`, and the same for
   `paystack-webhook`; both do their own authentication). Set secrets `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`
   (a service account with only the "Cloud Datastore User" role), `PAYSTACK_SECRET_KEY`. In the Paystack dashboard set the
   webhook URL to the `paystack-webhook` address. Test with test keys and Paystack's test cards.
3. Ship the app changes. Wait until old versions are no longer in use (or force an update), because an old app still
   calls the old function path and writes payment documents.
4. Apply `firestore.rules.hardened`.
5. Retire the old shared secret (`MIX_FUNCTION_SECRET`) and delete it from the app.

## Secrets: act on these now

- **Play upload key.** The keystore is in a public repository. If the app uses Play App Signing (the default for new apps),
  open Play Console, App integrity, and **request an upload key reset**, then create a new keystore and keep it out of git.
  If the app does not use Play App Signing, the app signing key itself is exposed: talk to Google Play support before
  publishing anything else.
- Remove the keystore files and `key.properties` from the repository **and its history** (for example with
  `git filter-repo`), add them to `.gitignore`, and treat every secret that was ever committed as public.
- Rotate `MIX_FUNCTION_SECRET` and the Supabase anon key if you rely on either for access control.
- If the Paystack secret key was ever in a committed file or a build, regenerate it in the Paystack dashboard.

## Not covered here

- POS: sale totals and stock are still decided by the till app. The real fix is to use the Mudatex till (server-priced, a
  second person confirms non-cash payments) or to move sale creation into a function like the one above.
- Admin/driver assignment uses fixed coordinates for the destination (the centre of Nigeria), so "nearest admin" is not
  really nearest; a separate correctness bug.
- Refunds and Paystack "failed" or "reversed" events are not handled; add them before relying on this for refunds.
