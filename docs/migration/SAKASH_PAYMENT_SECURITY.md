# Sakash: payment security problems and how to fix them

**Status:** Findings and a proposed order of work. Nothing in the live Sakash project has been changed. Based on a sample
of Sakash's Firestore rules, plus the architecture notes in the feature map. The Flutter app and the Supabase payment
functions were **not** read, so each item below says what the rules allow, not what the app does with it.

## What the rules allow today

| # | Rule | What someone with a normal customer account can do |
|---|---|---|
| 1 | `orders` create: any signed-in user, any fields | Create an order with a total of their choosing and `paymentStatus: "paid"`. If fulfilment or reports trust those fields, goods leave unpaid or underpaid. |
| 2 | `payments` create: any signed-in user, for themselves, any content | Write a payment record claiming any amount, status or provider reference. It can never be corrected or deleted (updates and deletes are off), so forged and genuine records sit side by side and cannot be told apart. |
| 3 | `payment_attempts` create and update: the owner, any content | Rewrite their own attempt to look successful. |
| 4 | `notifications` create: any signed-in user, in anyone's feed | Send a staff member a message such as "payment received, ship now". This is a ready-made social-engineering route. |
| 5 | `pos_sales` create: a POS operator, with no check that totals match items | Record a sale for less than the goods are worth, or for a method (cash, card) that did not happen. Voiding is admin-only, which is good. |
| 6 | `pos_analytics`, `admin_performance`: writable by operators or, for `admin_performance`, by any signed-in user naming themselves | Reports and performance figures can be falsified. |
| 7 | Stock: a POS operator may set `stockQuantity` to any lower number | Hide stock removal; drive stock negative. |
| 8 | Super-administrators are hard-coded account ids in the rules | Changing who is in charge needs a rules deployment; no audit trail of who held the power when. |
| 9 | (From the feature map) a shared function secret compiled into the app, and the app confirming payment when the customer returns from the payment page | Whoever extracts the secret can call the payment functions as the app; a customer who skips or fakes the return can mark an order paid. |

The root cause is the same in every row: **the app is trusted to report money, and the database believes it.** Rules can
check who is writing and what fields change; they cannot know whether Paystack actually received the money.

## The fix, in order of value

1. **Verify payments on a server you control.** Paystack calls a webhook when money moves. A server function (the
   existing Supabase function, or a Cloud Function) must: check the `x-paystack-signature` header (HMAC-SHA512 of the raw
   body with the secret key); look the transaction up with Paystack's verify call; confirm the reference belongs to a
   known order, the amount and currency equal what the *server* expects, and the status is success; then, in one
   transaction, write the `payments` record and mark the order paid; and ignore a reference it has already processed.
   The app only ever *displays* the result. (Mudatex's payment design is exactly this; see ADR 012.)
2. **Price orders on the server.** Creating an order, and starting the Paystack transaction, goes through a function
   that reads product prices itself and computes the total. The client sends product ids and quantities, never amounts.
3. **Lock the rules once 1 and 2 exist** (not before: the current app would stop working):
   - `payments`: `allow write: if false` (only the server writes); owners and admins may read.
   - `payment_attempts`: `allow write: if false` for clients.
   - `orders` create: require `status == "pending"`, `paymentStatus == "unpaid"`, no `paymentReference`, and
     `userId == request.auth.uid`; no client update of payment fields at all.
   - `notifications`: create only by the server.
4. **Stop POS from reporting its own totals.** Either create sales through a function that prices them, or retire the
   Sakash till in favour of the Mudatex till, which already prices, taxes and numbers every sale on the server, requires a
   second person to confirm card/transfer/mobile-money payments, and records who did what. This is the migration.
5. **Replace hard-coded super-admin ids with custom claims** set by a function that only an existing super-admin can call,
   so grants are auditable.
6. **Remove the shared secret from the app.** Functions authenticate the caller's Firebase ID token instead.

## Interim steps that need no app change

- Reconcile a sample period of orders, POS sales and `payments` against Paystack and bank statements. Anything that
  cannot be matched is suspect; this also tells you whether the weaknesses have been used.
- Turn on Paystack's own notifications and dashboard review for unusual successes and refunds.
- Review who holds admin and POS-operator access; remove anyone who no longer needs it.
- Rotate the shared function secret and the Paystack keys if there is any doubt they were extracted from a build.

## For Mudatex

Mudatex does not copy any of this. Its POS is server-priced and maker-checked today. When customer checkout is built
(roadmap phase 3), the Paystack adapter must follow step 1 above, with a test that a forged return, a replayed webhook,
a wrong amount and a bad signature each fail.
