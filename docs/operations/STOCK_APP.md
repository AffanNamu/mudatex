# Counting and receiving stock on a phone

For storekeepers, warehouse staff and stock controllers. Open the console on the phone, sign in, and choose **Stock (phone)**. Add it to the home screen (browser menu, "Add to Home screen") and it opens like an app; the Mudatex icon also offers a "Count or receive stock" shortcut.

## Before you start
- Pick the **Place** (shop, warehouse or store room) at the top. The phone remembers your choice.
- The phone keeps a **stock list** for that place: every active product, its barcodes, and what is on the shelf. It refreshes by itself when you have a connection (press *Refresh* to force it). With it, scanning, counting and receiving keep working when the signal drops. The line under *Place* tells you how old the copy is.

## Count
1. Scan a barcode (a Bluetooth/USB scanner types the code and presses Enter; or tap **Camera** on phones whose browser can read barcodes), type a SKU, or search by name.
2. Type how many you counted. You do not see what the books say, on purpose: it keeps the count honest. For pieces, each scan of the same barcode adds one.
3. Lot- and roll-tracked cloth shows one row per lot or roll the books know of at that place; count each.
4. Press **Send count**.

What happens next:
- Only the things you counted are compared. Anything you did not scan is left alone, so you can count one aisle at a time.
- Every difference goes to **one pending stock adjustment**. A second person with approval rights approves it in the console (*Inventory adjustments*); stock only changes then. You cannot approve your own count.
- The books are compared **as they were when you counted**, not when the count arrives. A sale rung up between your counting and the signal coming back does not turn into a false shortage.
- A count older than 7 days is refused: count again.
- A count in progress is saved on the phone, so a refresh, a locked screen or a flat battery does not lose it.

## Receive
- **Against an order**: open the approved purchase order for this place, scan each item as it comes off the delivery (or type the quantity), enter the lot or roll code for tracked cloth, and mark anything **damaged or wrong** with a reason (it is recorded but not stocked). Add the supplier's delivery note number and press **Record receipt**. The order's *received* and *still to come* numbers update; you can receive in several parts. Orders are opened while online; the receipt itself is safe to send later.
- **Without an order**: for stock with no purchase order (a gift, a transfer from a market stall). Scan, enter the quantity, and say where it came from.

## Look up
Scan or search to see what is on the shelf here: on hand, reserved for online orders, and free, per lot or roll. Online it is live; offline it uses the phone's copy and says how old it is.

## When the signal is bad
Counts and receipts are saved on the phone first, then sent. If there is no connection you will see "Saved on this phone", and the **Waiting** tab shows what is queued. It sends by itself when the connection returns (or press *Send now*). Each item has its own unique key, so a reply that gets lost on the way back can never record anything twice.

If the server turns something down (for example the order was cancelled while you were offline) it stays under **Waiting** in red with the reason; show it to a supervisor, then discard it.

## Who can do what
| Tab | Needs |
|---|---|
| Look up | `inventory.read` at that place |
| Count | `inventory.adjust` at that place |
| Receive against an order | `procurement.receive` at the order's place |
| Receive without an order | `inventory.receive` at that place |
| Approve a count's differences | `inventory.adjust.approve` (a different person) |

## Limits
- The stock list holds up to 4,000 products per place; the phone says if it was cut off.
- Reading barcodes with the camera depends on the phone's browser (current Chrome on Android works; some iPhones do not). A hardware scanner or typing always works.
- Counting is in each product's own unit (metres, pieces…), not in rolls or boxes.
