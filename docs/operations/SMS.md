# Text messages (SMS) about orders

Shoppers who tick **"Text me when my order is paid, sent or delivered"** in their account get a short text at those three
moments, in their language, with a link to their order. Nothing is sent to anyone who has not ticked the box, and the email and
phone notifications are unchanged. Placing an order, cancelling and refunds are not texted (they are in email).

Example: `Mudatex Store: Your order SO-000123 is on its way. https://shop.example.com/orders/SO-000123`

## Turning it on
Set these on the **API** project (Vercel) and redeploy. Without both, nothing is sent and nothing breaks.

| Name | Value |
|---|---|
| `TERMII_API_KEY` | from your Termii account (Settings → API) |
| `TERMII_SENDER_ID` | the sender name registered with Termii (3 to 11 characters). In Nigeria a sender ID must be registered and approved first, which takes a few days |
| `TERMII_CHANNEL` | optional: `generic` (default), `dnd` (reaches numbers that block promotional texts; costs more) or `whatsapp` |
| `TERMII_BASE_URL` | optional: Termii gives some accounts their own address |

## Read this before relying on it
- The Termii connection was written from Termii's public API description and **has not been tried with a real account yet**. After
  setting the key, tick the box on a test account, place an order, pay it, and check the text arrives. The exact request is
  `POST {base}/api/sms/send` with `{ to, from, sms, type: "plain", channel, api_key }`; if Termii has changed it, only
  `apps/api/src/notify/sms.ts` needs to change.
- Texts cost money per message. Only three moments per order are texted, to people who asked.
- Numbers are used as given at checkout. Ones starting `0` are taken to be Nigerian (`+234`); anything that cannot be a phone number is skipped silently.
- Each text is sent once per event; if the provider refuses, it is retried a few times, then given up (the order is never affected).
- Another provider can be added the same way (a few lines implementing `Texter`). WhatsApp messages need a WhatsApp Business account and approved templates, which Termii's `whatsapp` channel or the WhatsApp Cloud API require.
