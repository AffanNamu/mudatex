# Migrating Sakash (PFB) data into Mudatex

This is the runbook for the migration tooling in `apps/api/src/migration/sakash`. It follows the plan in the specification (section 13): profile, map, rehearse, run in parallel, cut over, retire.

**Status.** The importer, reconciliation and CLI are built and tested against a synthetic export that mimics PFB's data shapes (messy values included). The Firestore export script has been syntax-checked only: it needs `firebase-admin` and a real service account, so it has **never been run against your Firestore**. Treat the first real export as a rehearsal.

## What is migrated, and what is not

| Sakash collection | What happens |
|---|---|
| `products` | Become Mudatex products with one variant each (SKU `SAK-<id>`), price, attributes (fabric type, colours, sizes, yardage, promotions...) and **opening stock** |
| `categories` | Not imported. Each product already carries its category names |
| `orders`, `pos_sales`, `pos_receipts`, `payments` | Copied into a **read-only legacy archive** with a stable link to the source id and the document's total. Not turned into live Mudatex sales (that would change stock and the books) |
| `users`, `admins`, `rides`, `payment_attempts`, `app_settings`, `pos_analytics`, `admin_performance` | **Not migrated**, on purpose; the reason for each is printed in the report |

**Personal data.** Customer names, phone numbers, addresses, emails, user ids and device tokens are never copied. A deny-by-default allow-list (`scrub.ts`) keeps only listed fields, and the export script applies it at the source, so those values never reach the export files at all. `users` and `admins` are never even read.

**Units.** In PFB stock is a whole-number count and price is per item, so the default base unit is a **piece**. `yardage` is kept as a product attribute. If your products are really sold by the yard, say so before the first import, because the unit cannot be changed afterwards (set `baseUnit` in the config).

**Opening stock** is posted once per product, at its first import, as ordinary stock receipts ("Sakash opening balance") into the location you choose. It is **never re-synced** afterwards: while Sakash and Mudatex run side by side only one of them may be authoritative for stock, or counts will diverge.

## What you need to do by hand

1. **A Mudatex target.** An organization (see `docs/operations/DEPLOYMENT_AND_IDENTITY.md`), with a legal entity and a stock-holding location (a warehouse, branch or storage location) for the opening stock. Optionally a price list for the entity.
2. **A user to record as the importer.** Any existing active Mudatex user; the CLI takes their email.
3. **A Firebase service account for Sakash, read-only.** In the Firebase console for the PFB project: Project settings, Service accounts, Generate new private key. Better, create a dedicated service account with only the *Cloud Datastore Viewer* role. **Delete the key when you are finished.** Never commit it.
4. **Run the export** on a machine you trust (below).

## Step by step

### A. Export (read-only)

```bash
cd apps/api
npm ci && npm run build
npm install --no-save firebase-admin
node scripts/export-sakash.mjs --service-account ./sakash-key.json --out ./sakash-export
```

This writes `products.ndjson`, `categories.ndjson`, `orders.ndjson`, `pos_sales.ndjson`, `pos_receipts.ndjson` and `payments.ndjson`. It only reads. Delete the export directory when the migration is closed.

### B. Profile (no database needed)

```bash
node dist/migration/sakash-cli.js profile --input ./sakash-export
```

Read it. It shows record counts, duplicate and missing ids, products that cannot be imported (and why), how much opening stock there would be, document totals and date ranges, which fields would be dropped (the privacy view), and any collection the tool does not recognise.

### C. Configure

`migration.json`:

```json
{
  "actorEmail": "you@yourcompany.com",
  "legalEntityId": "<uuid of the legal entity>",
  "locationId": "<uuid of the warehouse or branch that receives opening stock>",
  "priceListId": "<uuid of a price list, optional>"
}
```

Optional: `"baseUnit": { "code": "pcs", "name": "Piece", "kind": "discrete", "precision": 0 }`.

### D. Rehearse in a throwaway database

```bash
export DATABASE_URL=postgres://...   # a staging database, not production
node dist/migration/sakash-cli.js plan      --input ./sakash-export --config migration.json
node dist/migration/sakash-cli.js import    --input ./sakash-export --config migration.json
node dist/migration/sakash-cli.js reconcile --input ./sakash-export --config migration.json
```

- `plan` runs the whole import and rolls it back, so you see exactly what would happen. Nothing is written.
- `import` is safe to repeat: unchanged records are skipped. Records changed in Sakash since the last import are only reported unless you pass `--update-changed`, which updates the product's details and price (not its stock).
- `reconcile` compares the export with Mudatex, exactly: every importable product is present, opening stock equals the source count, every archivable document is present with the same total, and every mapping still points at a real record. **Do not rely on migrated data until it prints "Reconciled".**
- Every source record is either imported or listed in the **exception register** (`legacy_import_exceptions`, by run). Errors mean the record was skipped; warnings mean it was imported without part of its data (for example, negative stock gives a product with no opening stock). Fix the data in Sakash and import again, or accept and record the exception.

### E. Parallel run

Keep Sakash authoritative for stock and sales while the business tests Mudatex in staging. Re-export and re-run `import` as often as you like in staging. Do not run both systems as live writers of stock.

### F. Cutover (production)

1. Agree a freeze time. Stop sales and stock changes in Sakash.
2. Export again and run `profile`, `plan`, then `import` and `reconcile` against **production** once. Opening stock is posted at this import.
3. Do a physical count of a sample against Mudatex stock. Corrections go through approved stock adjustments.
4. Start trading in Mudatex. Keep Sakash read-only.

**Rollback.** Before the first live sale in Mudatex, rollback is simple: discard the production data and resume Sakash. After sales have been made in Mudatex, rolling back means those sales must be re-entered in Sakash by hand. Decide your point of no return in advance.

### G. Retire

Keep Sakash's data read-only for as long as your retention policy requires. The legacy archive in Mudatex is a convenience copy with personal data removed; it is not a replacement for Sakash's own records.

## Limits to know about

- The importer has not been run on real PFB data. Real data will have surprises; expect to read the exception register carefully and adjust.
- Product variants are one per product. PFB's `variants` list and per-colour or per-size stock are kept only as attributes.
- Promotions (`promoDiscountPercent`) are kept as attributes, not turned into price rules.
- There are no customers in Mudatex yet, so customer history is not migrated.
- Orders and POS sales are archived, not replayed. Reports on them need the archive, and revenue history is not in the general ledger.
- Timestamps in `orders` stored as strings are interpreted as given; ambiguous local-time strings without a zone are read as UTC.
