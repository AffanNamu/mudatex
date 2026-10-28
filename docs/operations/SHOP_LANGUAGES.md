# Shop languages: English, French, Hausa

The online shop is available in **English, Français and Hausa**. A picker sits in the header; the choice is remembered on the device. On a first visit the shop uses the browser's language when it is French or Hausa, otherwise English.

## What is translated
Everything the shop itself says: navigation, footer, home page, the listing and filters, product pages, basket, checkout, sign-in, account, orders and their statuses, trade accounts, enquiry forms, delivery/about/contact and the other company pages, error and "offline" pages. Prices, dates and totals are formatted the same way in every language, so an amount never reads differently from one language to the next, and the server still decides every price.

## Product names, descriptions and departments
In the console, **Online store → Translations (French and Hausa)** lists the store tagline, every department and every published product with its English next to a box for the other language. Fill in what you want; a blank box shows the English. Prices, stock and codes are never translated, only words. Departments, titles and descriptions can be translated; the product's brand and codes stay as they are. The "Start with sample data" button includes French and Hausa wording for the sample store.

## Emails and phone notifications
Each shopper has a language on their account. It follows the picker (a device with no choice of its own adopts the account's), and order emails and phone notifications are written in it, with the same amounts and order numbers as the English.

## What is not (yet)
- **Messages that come back from the server** (for example "this coupon has expired") are English.
- **Page titles in the browser tab and search-engine snippets** are English.

## Review needed before launch
- **Hausa is a first draft written without a native speaker.** It must be read by someone fluent before launch, especially the delivery and returns page, the checkout wording, and the order emails (`apps/api/src/notify/order-copy.ts`). It uses the respectful plural form so it reads the same for men and women.
- The French is conventional shop French; a quick read by a French speaker from the markets you serve (Niger, Cameroon, Chad) is still wise.
- The delivery, about and divisions pages carry "to be confirmed" notes in all three languages; the company must confirm the facts first.

## How changes are made
All wording lives in `apps/shop/lib/messages/` (`en.ts` is the source; `fr.ts` and `ha.ts` must have the same keys and the same `{placeholders}`). A test fails the build if a key or placeholder is missing. To fix a word, edit the one line. To add a language, add a file, list it in `lib/i18n.tsx`, and the picker and detection pick it up.
