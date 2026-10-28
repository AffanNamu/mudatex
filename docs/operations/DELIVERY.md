# Delivery companies and parcel tracking

Mudatex does not deliver anything and does not manage riders. The business hands each parcel to a **delivery company**
(Nigerian, regional or international), and Mudatex records which one, follows the parcel and shows the customer where it is.
It is a pipeline: any delivery company can be plugged in, in one of three ways.

## 1. Add the delivery company (Delivery companies in the console)
Needs the *carriers.manage* permission. Choose how updates arrive:

| Way | When to use it | What staff do |
|---|---|---|
| **Staff enter** (`manual`) | The company has no way to send updates, or you have just started | Type the tracking number when sending; add progress updates by hand ("Out for delivery") when they call you |
| **The company sends us updates** (`webhook`) | The company, or a tracking service that watches their parcels, can call a web address when a parcel moves | Nothing: the stage moves by itself |
| **Connector** (`api`) | The company has an API and a Mudatex developer has written its connector | Choose the company when sending: the parcel is booked automatically and followed by asking the company hourly |

For every kind you can give **their tracking page** (`https://…{ref}`, with `{ref}` where the tracking number goes). The
customer gets a "Track on their website" button.

## 2. Sending an order
*Online orders → the order → Delivery company → Ship.* Pick the company, type the tracking number (not needed for a connector
company: it gives one), ship. Stock leaves the shelf, the customer is emailed, and their order page shows the parcel. An order
can still be sent with a courier name typed by hand.

## 3. What the customer sees
On their order page: the stage (*Handed to the delivery company, Picked up, In transit, Out for delivery, Delivered, Delivery attempt failed,
Returned to the shop*), the expected date if the company gave one, the company's words for each update, and the link to the
company's own tracking page. In English, French and Hausa (the Hausa wording still needs a native speaker's review).

## What happens automatically
- **Delivered**: when the company reports delivery, the order is marked delivered (as if staff had done it).
- **Delivery failed or returned**: the order gets a note and the order desk shows a warning. Nothing is refunded or re-sent automatically; staff decide.
- Updates arriving twice or out of order are harmless: each is recorded once, and the parcel's stage always comes from the
  *latest* update, so a late message cannot move it backwards.
- A word Mudatex has not been told about is kept as a note and does not change the stage. Add it to the company's **words for each stage** to make it count.

## Receiving updates from a company (webhook)
After adding a webhook company the console shows a **signing secret once** (lose it: use *New secret*). Give the company, or the
tracking service, the address `https://<your API>/webhooks/carriers/<company id>` (shown on the company's card) and the secret.

Each call is a `POST` with `Content-Type: application/json` and the header
`X-Mudatex-Signature: sha256=<hex HMAC-SHA256 of the exact body, keyed with the secret>`. Body, one update:

```json
{ "trackingRef": "SWT-9001", "status": "Out for delivery", "description": "With the rider", "location": "Kano",
  "occurredAt": "2030-01-02T08:00:00Z", "eventId": "their-id-123", "eta": "2030-01-03" }
```
or several: `{ "events": [ { … }, { … } ] }` (up to 100). Only `trackingRef` and `status` are required. `eventId` is how a repeat
is recognised; without it one is made from the tracking number, status and time. A wrong signature gets 401. A correctly
signed call always gets 200, with counts of what was recorded, repeated and unknown (a tracking number we have no parcel for).

`status` may be the company's own words, mapped by the company's **words for each stage** (`their word = ours`, one per line), or already one of ours:
`booked, picked_up, in_transit, out_for_delivery, delivered, failed, returned, cancelled`.

If a company or tracking service sends its **own format** (different field names, its own signature), it cannot call this address
directly. It needs a small connector or relay, which is the next section.

## Connecting a company's own system (connectors; for developers)
A connector is one file in `apps/api/src/shipping/` that implements `CarrierAdapter` (`adapters.ts`): `book()` creates the
shipment at the company and returns the tracking number, label link and expected date; `track()` returns the company's
latest events. Register it in `ADAPTERS`, then add a delivery company of kind "Connected by a Mudatex connector" and enter its
credentials (stored encrypted). Booking happens before the order is marked sent; if the company refuses, nothing changes and
staff see why. Open parcels are asked about hourly (once a day on Vercel's free plan, which only runs the scheduler daily).

**To build the first connector** (for example Speedaf, GIG, Sendbox, DHL or a tracking aggregator such as TrackingMore / AfterShip /
17TRACK that covers many companies at once) we need from the company: a test account and API credentials; the documentation
for creating a shipment and for tracking (and for webhooks, if they have them); the list of their status words; and their
public tracking page address. We could not find a public developer page for Speedaf, so ask their business or integration contact.

## Setup needed on the server
`SECRETS_ENCRYPTION_KEY` must be set (the same key webhooks use) for webhook secrets and connector credentials.
