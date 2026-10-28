# Sending online orders from the nearest shop

A group with several shops and warehouses does not want every online order to leave from the same place. Mudatex chooses the
sending location for each order automatically, from what you tell it about which places each location serves.

## Setting it up (Online store → Where orders are sent from)
The section appears once the store uses two or more stock locations. For each location, add an area:
- **Country** and **States** it serves (comma separated; empty means the whole country), for example *Kano Warehouse — NG — Kano, Kaduna*.
- **Priority**: when several locations serve the same place equally well, the lower number is tried first.
A location can have one area per country. Locations with no area are never excluded; they are tried after the ones that serve the address.

## What the system does when an order is placed
1. Puts the store's locations in order for the customer's address: locations that name the customer's **state** first, then locations
   that serve the **whole country**, then all the others in the order they were added to the store; ties by priority.
2. Looks for the **first location that has every item** in the quantity ordered, and sends the whole order from there.
3. If no single location has everything, takes each item from the locations in that same order, so the order may leave from
   more than one place. It is only refused if the locations together do not have enough.

The staff order page shows "Will be sent from / Sent from" with the location names.

## Things to know
- This chooses where stock is **reserved and taken from**. It does not pick a delivery company or change delivery fees (zones set the fees).
- Stock shown to shoppers is the total across all the store's locations.
- Changing areas affects new orders only. Existing orders keep the locations they reserved from.
- "Nearest" means "the places you said it serves", not distance on a map. Distance-based routing can come later if wanted.
