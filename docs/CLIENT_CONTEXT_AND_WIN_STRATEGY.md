# The client, the existing website, and how Mudatex wins

*26 October 2026. Based on public web search results only. The sandbox this was written in cannot open mudatex.com, so
nothing here describes the site's actual screens or features; those gaps are listed in section 3 and need a person to fill
them in.*

## 1. Who the client is (from public sources)

Mudatex is the trading name of **Mudassir and Brothers**, a Kano-based Nigerian group.

- Founded 1997 by Mudassir Idris Abubakar as an importer of consumer goods (fabrics, electronics, furniture, kitchenware),
  moved into manufacturing fashion fabrics in 2005 and furniture in 2007, then into real estate; owns shopping malls in Kano
  and other northern cities. ([Wikipedia](https://en.wikipedia.org/wiki/Mudassir_and_Brothers))
- Brands listed there: Empire Atampa, Super Conclusive, Florance, Flora, Ismile, Egyptian Kamfala, Mudatex Java, Super Xperia.
- Sells retail and wholesale; the website's About page gives a flagship address in Kwari Market, Kano, and says it supplies
  wholesale and bulk. ([mudatex.com, About](https://mudatex.com/about-us/))
- A 2019 report announced a planned textile factory in Kano worth over $50 million
  ([Daily Trust](https://www.dailytrust.com.ng/50m-textile-coy-to-be-established-in-kano.html)); completion is not confirmed.
- Staff numbers differ by source (Wikipedia about 1,200; ZoomInfo's automated profile 201 to 500). Treat as roughly several hundred
  to a thousand-plus, and confirm with the client.

**Implication:** the client is a multi-brand manufacturer, importer, wholesaler and retailer with many locations and a large
trade customer base. That is exactly the shape the Mudatex platform was designed for (groups, companies, countries, shops,
warehouses, manufacturing). A web shop alone does not serve this business.

## 2. The existing website

mudatex.com presents itself as "Premium African Textiles, Lace & Lifestyle Store", selling wax prints, lace and brocade, with
veils, shoes and bags, and says it ships worldwide from Nigeria
([mudatex.com](https://mudatex.com/)). It is a retail storefront.

## 3. What we do not know yet (needs a human to check)

Open the site on a phone and a computer and answer, or send screenshots of: home, a category, a product page, cart, checkout,
sign-in, any wholesale page.

- How are prices shown: per yard, per piece, per bale? Are wholesale prices visible, hidden, or by request?
- Is there stock shown per location? Out-of-stock handling?
- Payment options and currencies; delivery options; order tracking; does it work well on a phone?
- Is there an account area, order history, re-order, wishlist, reviews?
- WhatsApp, phone or form ordering? Any live chat?
- Languages (English, Hausa, French)?
- What does the client say is wrong with it? What did they ask us to deliver?

## 4. What "more than a web shop" means here

Three levels. A competing vendor can reach the first. The second and third are where Mudatex already differs.

**Match (table stakes):** a fast, phone-first storefront with search and filters (fabric type, colour, width, price),
clear units, a real checkout with server-verified payments, order tracking, accounts, and an order history with re-order.

**Beat (what a store cannot do, because it is not connected to the business):**
- **Live stock by shop, warehouse and mill**, shown to the customer ("12 pieces at Kwari, 40 at Kaduna"), because the store
  reads the same ledger as the tills.
- **Dye-lot guarantee.** Wax and lace customers must get one batch for one order or the colours do not match. Mudatex already
  tracks lots and rolls; the storefront can reserve a whole order from one lot.
- **Wholesale portal separate from retail** (the DHL advice for Nigerian fashion brands: separate wholesale catalogue, pricing
  and payment terms for stockists, [DHL](https://www.dhl.com/discover/en-ng/e-commerce-advice/e-commerce-trends/winning-online-sales-channels-for-nigerian-fashion)):
  tiered prices, minimum quantities, pack and bale formats, credit limits and statements, standing orders, a named
  account manager.
- **One till and one book across every mall**, so a sale in Sokoto and an online order in Lagos are the same stock and the same
  accounts.
- **Production-aware availability:** what is coming off a mill run, and when, visible to sales.

**Leapfrog (where the market is heading):**
- **WhatsApp-first ordering.** Nigerian fashion trade runs on WhatsApp and negotiation; web shops struggle with price
  haggling ([BusinessDay](https://businessday.ng/life/article/the-whatsapp-economy-how-social-commerce-is-rewriting-retail-rules/)).
  Orders and quotes started in WhatsApp should land in the same system, with an "offer" step that a manager approves.
- **Pattern search:** find a design by photo or code across all brands.
- **Distributor and agent network:** their own price lists, stock and commission statements.
- **Hausa and French** as well as English; naira, CFA and cedi pricing for the West and Central African export base.
- **Offline-capable tills** for malls with unreliable connectivity.
- **Forecasting and replenishment** from sales into production and purchasing.

## 5. What the platform already has, and what is missing

Already built (see `PROJECT_OVERVIEW_AND_STATUS.md`): groups, companies and shops, scoped access, ledger inventory with lots
and rolls, unit conversions, price lists and tax, a server-priced till, procurement, accounting, manufacturing, quality
holds, an audit trail, and a live deployment.

Missing for a winning demo, in order:

1. **Setup screens** (so a fresh system can be configured in the browser): next.
2. **Customers and trade accounts:** customer records, wholesale accounts, **credit limits, receivables, statements**
   (the accounting core exists; receivables do not).
3. **Sales orders and quotations:** order states, partial fulfilment, invoices, delivery notes.
4. **Storefront (retail) and wholesale portal,** phone-first, with live stock by location and lot-aware reservation.
5. **Online payments:** Paystack with server verification (design and tests already written).
6. **WhatsApp ordering** and notifications.
7. **Offline till;** then mobile apps.
8. **Dashboards** for owners: sales by brand, shop and country; stock cover; margins once costing is agreed.

## 6. The story to tell the client

"Today you have a shop on the internet. With Mudatex, every roll from your mill, every piece in every mall and warehouse, every
wholesale buyer's credit, every sale on a till or a phone, and every naira in the books is one system, so your customer sees
what you really have, your traders order and reorder without a phone call, and you see the whole group on one screen."

## 7. Questions for the owner

1. Who is the client contact, and what exactly did they ask for (replace the site, or run the whole group)?
2. How much of the wholesale trade is on credit, and how is credit approved today?
3. How many locations and which currencies at launch?
4. Which brands and how many products?
5. Which parts of the existing site do they like or dislike?
