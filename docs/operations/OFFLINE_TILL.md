# Selling when the internet is down

This is for shop managers and cashiers. The reasoning behind it is in `docs/adr/002-offline-till.md`.

## What works offline
- **Cash sales of ordinary products.** The till prices them itself, from a price list it saved earlier.
- Searching by name, SKU or barcode, quantities, discounts up to the register's limit, change, and a printed receipt.

## What does not work offline
- Card, bank transfer and mobile money (they need confirmation).
- Rolls and lots (they need a lot choice).
- Returns and refunds, cancelling a sale, opening or closing a session.

## Every day
1. **Open the session while you are online.** The till then saves a price list on the device. You will see "Offline selling is ready".
2. **If the line drops,** a yellow banner says "Working offline". Carry on selling cash. The receipt number starts with `OFF-` and is provisional.
3. **Do not clear the browser's data** or reset the device while sales are waiting. They are stored on the device until they are sent.
4. **When the line comes back** the sales are sent by themselves and get their official receipt numbers (the banner tells you how many). You can also press *Send now*.
5. **Close the session only after everything is sent.** The till will not let you close while sales are waiting.

## Good to know
- The saved price list is good for **24 hours** and only for the cashier and session it was saved for. After that the till refuses to sell offline until it has been online again.
- The server **prices each sale again** when it arrives, using the prices that were in force when the sale was made. If its total differs from the receipt the customer got, the difference is recorded, and shows up in the drawer count at closing.
- If the books showed less stock than you sold, the sale stands. The shortfall appears for the stock controller under **Offline shortfalls** to explain and fix.
- If the server turns a sale away (for example, the session was closed), it stays on the screen in red with the reason. Show it to a manager. The cash has been taken, so it must be dealt with.
- Reloading the page offline works: the app and the saved price list come back from the device.

## Set up once per device
Open the console in the browser once while online (so the app is saved for offline use), then sign in and open a session. Use the same browser tab for the shift: closing the browser ends the sign-in, though unsent sales stay safe on the device and send after you sign in again.
