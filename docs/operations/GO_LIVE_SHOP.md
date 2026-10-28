# Putting the customer shop live

This is the second website: the shop customers use. It is a separate Vercel project from the staff console, built from the same repository, and it talks to the same API and the same Supabase project.

You already have: the API on Vercel, the staff console on Vercel, Supabase (database and sign-in). Nothing here changes those, except one Supabase setting (step 1) and one API setting (step 5).

## 0. What you will end up with

| Site | Who uses it | Folder | Example address |
|---|---|---|---|
| Staff console | your staff | `apps/web` | `mudatex-console.vercel.app` |
| **Customer shop** | customers | `apps/shop` | `mudatex-shop.vercel.app`, later `shop.mudatex.com` |
| API | both | `apps/api` | `mudatex-api.vercel.app` |

## 1. Let customers create accounts (Supabase)

Staff are invited, so sign-ups were switched off. Customers need to create their own accounts. This is safe: the staff API only accepts people you added as staff, so a customer who signs up cannot enter the console or see any staff data.

1. Supabase, **Authentication**, **Sign In / Providers** (or **Settings**). Turn **Allow new users to sign up** ON.
2. Same page: keep **Confirm email** ON. Customers get a confirmation link, which proves the email is theirs.
3. **Authentication, URL Configuration**: add the shop address (for example `https://mudatex-shop.vercel.app`) to **Redirect URLs**. Leave the **Site URL** as it is.
4. **Authentication, Emails**: Supabase's built-in email sender is limited to a few emails per hour. Before launch, connect a real sender (SMTP) there, for example your own mail provider, so confirmation emails always arrive.

## 2. Create the store in the staff console

**Fastest way to see it working:** sign in to the console, open **Setup**, and press **Start with sample data**. It creates a sample textile company, 12 products with prices and stock, a till, and a live online store (web name `demo`) in a few seconds. It only works on an empty system. You can then skip to step 3 and use `demo` as the shop's web name. Change or remove anything later, and enter your own real data when you are ready.

**Or set it up by hand.** Sign in to the console and use the screens in this order:

1. **Setup**: add your company, its shops and warehouses, units (m, yd, roll), a tax code, a price list, and prices for your products. Add a till register for each shop.
2. **Online store, Create a store**: pick the company, the price list customers should be charged, and the warehouses online orders may take stock from. Choose a *web name*, for example `mudatex`.
3. Add **departments** (Lace, Ankara, Brocade, Atampa…).
4. **Products sold online**: add each product to the store, give it a title, a department, picture links and badges, then publish it. A product needs a current price to be published.
5. **Delivery zones**: add at least one. Shoppers cannot check out without a delivery zone for their address.
6. **Contact and bank-transfer details**: WhatsApp number, phone, email, and the bank account customers pay into.
7. Press **Go live**.

> **Speed tip.** The API's Vercel project and the shop should run in the same region as the database. Your Supabase database is in Frankfurt (eu-central-1), so both projects are set to Frankfurt (`fra1`) in their `vercel.json`. If you ever see slow pages, check **Settings, Functions, Region** in Vercel shows Frankfurt.

## 3. Create the Vercel project for the shop

1. Vercel, **Add New, Project**, import the same GitHub repository.
2. **Root Directory**: `apps/shop`. Framework: Next.js (detected).
3. Environment variables:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | your API address, no trailing slash |
| `NEXT_PUBLIC_SHOP_SLUG` | the web name from step 2, for example `mudatex` |
| `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the Supabase **publishable** key (never the secret or service key) |
| `NEXT_PUBLIC_SITE_URL` | the shop's own public address |

4. Deploy.

## 4. Allow the shop to call the API

In the API's Vercel project, add the shop's address to `CORS_ORIGINS` (comma separated, no spaces, no trailing slash), for example:

`https://mudatex-console.vercel.app,https://mudatex-shop.vercel.app`

Then redeploy the API.

## 5. Try it

1. Open the shop. You should see your departments and published products.
2. Create a customer account with an email you own. Confirm it, sign in.
3. Add a fabric to the basket, check out with a saved address, and place a bank-transfer order.
4. In the console, **Online orders**: open the order, enter a bank reference, confirm payment, then prepare, ship (this takes the stock off the shelf) and deliver.
5. Check the stock in **Inventory** went down only when you shipped.

## 5b. Install it on a phone (no app store needed)

The shop and the staff console are both installable web apps.

- **Android (Chrome):** open the site, tap the menu, then **Install app** (or use the *Install the app* link at the bottom of the shop). It gets its own icon and opens full screen.
- **iPhone (Safari):** tap **Share**, then **Add to Home Screen**.

The shop keeps its pictures and pages ready so repeat visits are fast, and shows a friendly page if the line drops (the basket is saved on the phone). Accounts, baskets and orders are never stored for offline use. For the till, install the *console* the same way on the shop tablet; see `OFFLINE_TILL.md`.

## 6. Accept card payments (Paystack)

Bank transfer works without this. Card and online-banking payments need a Paystack account.

1. Create a Paystack account and, for testing, copy the **test secret key** (it starts with `sk_test_`). Keep it secret: it goes only into the API's Vercel settings, never into the shop, the repository or a chat.
2. API Vercel project, **Settings, Environment Variables**: add `PAYSTACK_SECRET_KEY` with that key. Redeploy the API.
3. Paystack dashboard, **Settings, API Keys & Webhooks**: set the **Webhook URL** to `https://YOUR-API-ADDRESS/webhooks/paystack`.
4. Tell the store its own address (so Paystack can send shoppers back). In the console, or with the API: set the store's `siteUrl` to the shop's address, for example `https://mudatex-shop.vercel.app`. The shop only offers card payment once this is set and the key is present.
5. Test with Paystack's test card numbers. The server asks Paystack to confirm every payment and compares the amount with the order; a payment that does not match is held for a person to look at and the order stays unpaid.
6. For real money, switch to the **live** key (`sk_live_…`) and the live webhook. The API refuses to start in production with a test key.

If a customer's card payment arrives after their order has already lapsed, the money is kept on the order and recorded as owed back, so nothing is lost.

**Refunds.** In the console, open the order and use *Refunds*. One person asks (permission `orders.refund`); a different person approves (`orders.refund.approve`). A card refund is then sent back through Paystack automatically. A bank refund is paid out by hand, and the approver records the bank reference. Two Paystack details still need checking on your test account before you rely on automatic card refunds: that the refund request succeeds, and that its "refund processed" notice reaches the webhook (an unconfirmed card refund can always be marked as paid out by hand).

## 7. Order emails (Resend)

The shop emails customers when an order is placed, paid, shipped, delivered or cancelled.

1. Create a free account at resend.com and verify the domain you will send from (for example `mudatex.com`) by adding the DNS records they show.
2. Create an API key. In the API's Vercel settings add:
   - `RESEND_API_KEY`: the key
   - `MAIL_FROM`: for example `Mudatex <orders@mudatex.com>`
3. Redeploy the API. Place a test order: the confirmation email should arrive within seconds.

Without these two settings no emails are sent and nothing else is affected. On Vercel's free plan the API sends pending emails right after each order action, so they do not wait for the once-a-day schedule.

## 8. What is not live yet

- Trade accounts are done (apply, approve with a trade price list, credit limit and terms, order on account, statements). Make a *wholesale price list* in Business setup first.
- WhatsApp and SMS messages about order status (email is done).
- Trade accounts with credit terms, statements and standing orders for wholesale buyers.
- The free Vercel and Supabase plans are for testing. Move to the paid plans before taking real orders.
