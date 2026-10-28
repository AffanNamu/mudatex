# Returns from online orders

Customers can ask to send goods back from a delivered online order. Staff decide, the money goes back through the normal
two-person refund, and the goods are booked in and, if they can be sold again, put back on the shelf.

## The customer's side (their order page → Returns)
- The form appears once the order is **delivered**, and only for as long as the store's **return window** lasts (default **48 hours
  after delivery**, matching the delivery and returns page; change it under *Online store → Contact and bank-transfer details → Time
  allowed for returns*; 0 turns online returns off).
- They choose which items and how many (never more than they bought, counting other open requests), a reason (*damaged, not what I
  ordered, changed my mind, something else*) and an optional note. Pressing the button twice is one request.
- They can withdraw a request until staff decide. They are **emailed the decision** in their language.

## The order desk (Online orders → the order → Returns)
Needs *orders.refund* to decide and *orders.fulfil* to book goods in. The home page shows "online returns to decide".
1. **Approve** or **Decline**. A decline needs a note (the customer reads it). Approving works out what the goods are worth (each item's
   price with tax and discount, pro rata to the quantity returned; delivery is not refunded) and raises an ordinary **refund request**
   for it, limited to what the customer has actually paid and not yet had back. **A different person must approve that refund** before any
   money moves, exactly like any refund (see *Refunds*).
2. When the goods arrive, **Goods received**: tick the items that can be sold again and choose the shelf location. Those go back into stock;
   the others are simply booked in. Rolls and lot-tracked goods are not put back automatically (so their roll or lot code is kept): add them
   through Inventory.
3. Every step is on the order's history and in the audit log.

## Things to know
- A return does not change the invoice; the refund shows on it.
- An order paid on account with nothing paid yet raises no refund (there is no money to send back); the approval note says so, and the
  balance owed is dealt with in the trade account.
- Cut fabric: the delivery and returns page says uncut fabric, or damaged and wrong goods, only. The system cannot tell, so staff judge at the decision.
