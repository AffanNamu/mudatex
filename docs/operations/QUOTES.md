# Quotes for trade buyers

For whoever deals with wholesale customers. A quote fixes the prices for a trade buyer until a date. The buyer accepts it
in the shop, and the order is placed at exactly those lines and prices.

## Making a quote (Quotes in the console)
1. **New quote**: choose the business (any with an approved trade account), the date the prices hold until (up to 90 days),
   an optional note, and the lines: product, quantity and, if you agreed one, the price per unit.
2. Leave the price empty and the line is priced at the business's **trade price**. The server works out tax and rounding
   exactly as it does for any order; you never type a total.
3. A price **below the trade price** needs the *quotes.price.override* permission; a price at or above it does not. The
   trade price at the time is kept on the line, so you can always see what was conceded.
4. Edit a draft as often as needed. **Send to the buyer** emails them (in their language) and fixes the quote: a sent
   quote can only be cancelled and replaced.

## What the buyer sees
The quote appears under *Trade account → Quotes* and in the email link. They choose a saved delivery address and whether to pay
on account (within their credit, on their terms) or by bank transfer, then **Accept and place the order**. They can also
decline. Delivery is added when the address is chosen; the goods are at the quoted prices whatever has happened to the price
list since.

## Rules the system enforces
- **Nothing is held until acceptance.** Stock is reserved when the order is placed; if there is not enough by then, the order
  is refused and the quote stays open.
- One quote becomes one order, once. A retry (a double tap, a bad connection) returns the same order.
- A quote **expires** on its date without anyone doing anything; the buyer sees it as expired and cannot accept it.
- A business that is **on hold** (for example for late payment, see COLLECTIONS.md) cannot accept a quote; staff cannot send
  it a new one.
- Coupons cannot be combined with a quote.
- Every quote, edit, send and cancellation is in the audit log with the lines and prices.

## Permissions
`quotes.manage` to make, edit, send and cancel quotes; `quotes.price.override` to price below the trade price list. The group
administrator has both.
