# Shop languages: English, French, Hausa

The online shop is available in **English, Français and Hausa**. A picker sits in the header; the choice is remembered on the device. On a first visit the shop uses the browser's language when it is French or Hausa, otherwise English.

## What is translated
Everything the shop itself says: navigation, footer, home page, the listing and filters, product pages, basket, checkout, sign-in, account, orders and their statuses, trade accounts, enquiry forms, delivery/about/contact and the other company pages, error and "offline" pages. Prices, dates and totals are formatted the same way in every language, so an amount never reads differently from one language to the next, and the server still decides every price.

## What is not (yet)
- **Product names, descriptions, department names and the store tagline** are shown as the company wrote them in the console. Translating them needs per-language fields on products; say when you want that.
- **Emails and phone notifications** to shoppers are still English.
- **Messages that come back from the server** (for example "this coupon has expired") are English.
- **Page titles in the browser tab and search-engine snippets** are English.

## Review needed before launch
- **Hausa is a first draft written without a native speaker.** It must be read by someone fluent before launch, especially the delivery and returns page and the checkout wording. It uses the respectful plural form so it reads the same for men and women.
- The French is conventional shop French; a quick read by a French speaker from the markets you serve (Niger, Cameroon, Chad) is still wise.
- The delivery, about and divisions pages carry "to be confirmed" notes in all three languages; the company must confirm the facts first.

## How changes are made
All wording lives in `apps/shop/lib/messages/` (`en.ts` is the source; `fr.ts` and `ha.ts` must have the same keys and the same `{placeholders}`). A test fails the build if a key or placeholder is missing. To fix a word, edit the one line. To add a language, add a file, list it in `lib/i18n.tsx`, and the picker and detection pick it up.
