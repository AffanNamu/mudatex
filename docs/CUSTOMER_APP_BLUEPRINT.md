# Customer app and company website: blueprint

*26 October 2026. Compares the Sakash customer app (read from `AffanNamu/PFB`), the current mudatex.com (read from screenshots
supplied by the owner on a phone), and what the new Mudatex customer experience must do to win the client.*

## 1. What Sakash's customer app does (read from the code)

Guest browsing; home with featured, trending, best-seller and new-arrival rows; browse by **category, gender and occasion**
(wedding, burial, naming, birthday, sallah, corporate); search; product detail with fabric attributes (type, material, colours,
sizes, yardage, GSM, care, origin) and badges; favourites; cart (local for guests, saved when signed in); coupon codes;
**delivery fee estimated from the customer's address** (base fare plus per kilometre); Paystack checkout; orders list and
detail with status, price breakdown and reference; saved delivery addresses with autocomplete; push notifications; WhatsApp
and email support; a tailoring entry; dark mode.

Weaknesses (see `migration/sakash-hardening/`): the app decides prices, coupons and delivery fees and marks orders paid on a tap;
order totals ignore delivery and coupons; nearest-admin routing uses a fixed point; no stock check at checkout; no variants
(each colour is a separate product), no wholesale.

## 2. What mudatex.com does today (from screenshots)

Polished phone-first store in a brown and cream brand. Departments: wax prints, premium lace, brocade, shadda, laffaya,
material, yard, veils, shoes, bags, furniture, children, tailoring, abaya and gown, lingerie and sleepwear, perfume,
cosmetics, kitchenware. Hero carousel, featured and new-arrival rows, wishlist hearts, floating chat button, blog, lookbooks,
community, "buyer protection", worldwide shipping, a "how it works" animation. Product page: gallery, price, "in stock · 100
available", colour swatch, quantity, add to cart, **buy now**, wishlist, **notify me on price drop**, frequently bought
together with bundle total, customers also bought, more from department, reviews, write a review, questions and answers.
Footer: help centre, track order, returns and refunds, shipping info, deals and flash sales, tailoring services, newsletter;
payment badges (Visa, Mastercard, Verve, PayPal, bank, USSD, MoMo).

Weak spots visible in the screenshots:
- **No size or fabric-length selection** even though the description says "size 58, 60, 62": sizes live in a text blob, and
  the description quotes ₦82,000 while the price shows ₦85,000.
- **Colour variants are separate products** ("frequently bought together" shows four near-identical abayas).
- **Review histogram shows 70%, 49%, 40%, 35%, 31% on a product with zero reviews** (placeholder bars that sum past 100%).
- **"3 viewing now", "16 viewing now"** counters that look invented, which erodes trust once noticed.
- Fabric has **no unit logic** (yard, piece of 6 or 12 yards, roll); no wholesale or bulk prices; no minimums; no credit.
- Some category pictures do not match their labels (perfume shows tulips, "yard" shows a mountain).
- The blog's lead article is dated 2025.
- No visible store locator, WhatsApp ordering, or account tier for traders.

## 3. What Mudatex does better (the build list)

| Capability | Sakash | mudatex.com | Mudatex target |
|---|---|---|---|
| Real variants (size, colour, width) in one product | no | partial | yes, selectable, each with its own stock |
| Sell fabric by yard, metre, piece (6/12 yd), bale or roll with live conversion | partial | no | yes, one price per base unit, price and stock shown in the chosen unit |
| Live stock per shop, warehouse and mill | no | total only | "available at Kwari, Kaduna mall, ships from Kano warehouse" |
| One dye-lot per order (colour match) | no | no | yes: order reserved from a single lot where possible, or customer warned |
| Honest social proof | n/a | invented counters | only verified-purchase reviews; real stock counts |
| Server-priced cart, coupons, delivery | no (app decides) | unknown | yes, always server-side, with the same engine as the till |
| Delivery quote | by distance | at checkout | by zone and state, free-over thresholds, ETA, shown on the product page |
| Online payment | Paystack, trusting the app | cards, PayPal, bank, USSD, MoMo (listed) | server-verified; provider adapters per country; bank transfer with proof upload; pay on delivery where allowed |
| Tailoring and made-to-order | entry only | "made to measure" | measurement profiles, design reference photos, a work order in manufacturing, due date, fitting and approval, status updates |
| Wholesale and trade accounts | no | no | application and approval, trade price tiers, minimum order, bale packs, **credit limits, statements, reorder, standing orders**, account manager |
| WhatsApp | support link | chat bubble | orders, quotes and offers started in WhatsApp land in the system; cart share link; order status messages |
| Wishlist and price-drop alerts | yes / yes | yes / yes | yes, plus back-in-stock |
| Order tracking | status | paid, packed, shipped, delivered | same stages from the real ledger, with delivery proof, returns and refunds as requests |
| Languages and currencies | English, naira | English, naira | English, Hausa, French; naira, CFA, cedi |
| Same system as the tills and the books | no | no | yes: one stock, one customer, one set of accounts |
| Staff tools | admin screens in the app | unknown | catalogue publishing, department and banner management, order desk, review moderation, enquiries inbox |
| SEO and speed | app only | unknown | server-rendered pages, structured data, fast on weak phones |

## 4. Architecture decisions

1. **The public site is a separate web app (`apps/shop`) built with Next.js**, because a retail site lives on search engines and
   social previews and must be fast on weak connections. It renders product and department pages on the server and calls the
   same API. (The staff console stays a single-page app.)
2. **Customers are a separate population from staff.** Customer accounts use the same sign-in provider but live in their own
   table and are served by `/shop/...` endpoints. A customer's sign-in token cannot open any staff endpoint, and staff
   permissions do not apply to customers.
3. **A storefront is a configuration:** which company sells, which price list, which locations' stock is shown, which
   departments and products are published, which delivery zones apply. One platform can run several storefronts (retail,
   wholesale, a country site, a brand).
4. **Publishing is separate from the catalogue.** Staff decide what appears, with its web title, description, pictures,
   badges and department. The catalogue stays the single source of truth for units, variants, stock and prices.
5. **Prices, stock, coupons and delivery are computed by the server** with the same engine the till uses.
6. **Orders reserve stock** the moment they are placed and release it if unpaid after a time limit.
7. **Payments are verified by the provider's signed notification** and by asking the provider, never by the browser
   (`migration/sakash-hardening/` has the tested design).

## 5. Build order

| # | Piece | Result | Status |
|---|---|---|---|
| M1 | Storefront configuration, departments, publishing, customers, addresses, wishlist, delivery zones, public catalogue API | A storefront can be defined and its catalogue read by anyone | Done |
| M2 | Console screens: setup (companies, locations, units, tax, price lists, registers, people) and storefront publishing | A fresh system can be configured and published from the browser | Done |
| M3 | Sales orders, stock reservation, order tracking, order desk in the console | Orders flow into stock and the books | Done |
| M4 | The storefront web app: home, departments, search, product page with variants and units, cart, checkout, accounts, orders, wishlist | A customer can buy | Done |
| M5 | Payments: Paystack with server verification, bank transfer with proof, refunds | Real money | Paystack and bank transfer done; refunds payout not yet |
| M6 | Trade accounts: application, approval, price tiers, credit, statements, reorder | The wholesale side | Not started |
| M7 | Reviews and Q&A (verified), WhatsApp ordering and notifications, tailoring requests | Differentiators | Reviews, tailoring (made-to-order) and email done; Q&A, WhatsApp and push not yet |
| M8 | Corporate pages (about, brands, locations, careers, contact), blog and lookbooks, languages | The company website | Done except blog, lookbooks and languages |
| M9 | Offline till and mobile apps | Reach | Not started |
