# Two-step sign-in for staff

Staff open the company's money, stock and customer records, so a password alone is not enough. Mudatex supports a second
step: a 6-digit code from an **authenticator app** (Google Authenticator, Microsoft Authenticator, Authy and similar).
It is provided by Supabase Auth; nothing extra is installed.

## For each staff member
1. Sign in, open **Security** (top right), choose **Set up an authenticator app**.
2. Scan the picture with the app (or type the key it shows), then enter the 6-digit code.
3. From then on, every sign-in asks for the password and then a code. To turn it off, open **Security** and **Remove**
   (needs a signed-in-with-code session).

A person who loses their phone cannot sign in. An administrator removes the old authenticator in the Supabase dashboard
(*Authentication → Users → the person → Factors → delete*), after which they sign in with the password and set up again.
Do this only after confirming by phone or in person that it really is them.

## Making it compulsory (recommended before real data)
1. In Supabase: *Authentication → Sign In / Providers → Multi-Factor* — make sure **TOTP** is enabled (it is by default).
2. Have **every** staff member set up their app first, starting with the administrators.
3. On Vercel (API project) set `STAFF_MFA` = `required` and redeploy.

When it is on, the API refuses every staff request from a sign-in that did not use a code, with a message saying so. Anyone
who has not set up an app is taken to the setup screen straight after their password and cannot do anything else until they have.
Customers of the online shop are not affected.

If you turn it on too early and lock yourself out: set `STAFF_MFA` back to `off` (or remove it) and redeploy.

## What it does not do
- It does not cover the shop customers (they sign in with the shop's own screens).
- Codes are the only second step for now; there are no SMS codes or recovery codes. Keep at least two administrators set up.
