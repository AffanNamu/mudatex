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

Sign in to the console and use the new screens, in this order:

1. **Setup**: add your company, its shops and warehouses, units (m, yd, roll), a tax code, a price list, and prices for your products. Add a till register for each shop.
2. **Online store, Create a store**: pick the company, the price list customers should be charged, and the warehouses online orders may take stock from. Choose a *web name*, for example `mudatex`.
3. Add **departments** (Lace, Ankara, Brocade, Atampa…).
4. **Products sold online**: add each product to the store, give it a title, a department, picture links and badges, then publish it. A product needs a current price to be published.
5. **Delivery zones**: add at least one. Shoppers cannot check out without a delivery zone for their address.
6. **Contact and bank-transfer details**: WhatsApp number, phone, email, and the bank account customers pay into.
7. Press **Go live**.

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

## 6. What is not live yet

- Card payments (the shop offers bank transfer only until Paystack is connected and verified on the server).
- Refund payouts: cancelling a paid order records the refund owed; paying it out is manual.
- Customer emails and WhatsApp messages about order status.
- The free Vercel and Supabase plans are for testing. Move to the paid plans before taking real orders.
