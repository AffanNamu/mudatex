# Invoices and receipts

For whoever deals with online and wholesale orders. Every online order has a printable **invoice** (money still owed),
**receipt** (paid in full) or **cancelled order** page. The customer opens it in the shop; staff open the same page
from the console.

## Where to find it
- **Customer**: *Your orders → the order → Invoice / receipt*, then **Print or save as PDF**. Customers see only their own orders.
- **Staff**: *Online orders → open an order → Invoice / receipt*, then **Print**. Needs the *orders.read* permission.

## What is on it
Seller (store name, legal entity, address, phone, email, tax ID), buyer (the business name and tax ID for a trade account),
delivery address, every line with quantity, unit price and tax rate, goods total, discount or coupon, delivery, order total,
a tax summary by rate, payments received, refunds paid, the **balance still owed** and, while money is owed, the bank
details to pay into with the order number as the reference.

Everything is read from what was recorded when the order was placed and paid. Nothing is recalculated, so the paper can
never disagree with the order. A cancelled or expired order shows no balance.

## Setting it up
*Online store → Contact and bank-transfer details*:
- **Tax ID on invoices**: your tax identification number.
- **Invoice footer**: one or two lines (returns policy, thank-you).

## What it is not (yet)
The document is numbered with the **order number**. A formal tax invoice with its own gap-free number depends on the
finance decisions still open (tax registration and the country rules), so it is not issued yet. Until then, check with your
accountant before relying on this paper as a statutory tax invoice.
