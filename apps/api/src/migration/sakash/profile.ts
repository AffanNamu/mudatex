import { mapProduct } from './products.js';
import { ARCHIVED_COLLECTIONS, EXCLUDED_COLLECTIONS, scrubDocument, toNumber } from './scrub.js';
import { docId, type SourceData } from './source.js';

/** Data profiling (spec step A): what is in the export, what is wrong with it, and what the migration will do with it. */
export function profile(data: SourceData, present: string[] = Object.keys(data)) {
  const products = data.products ?? [];
  const seen = new Set<string>();
  const productIssues: Record<string, number> = {};
  let importable = 0;
  let stockPieces = 0;
  let zeroPriced = 0;
  let duplicates = 0;
  let noId = 0;
  const prices: number[] = [];
  for (const p of products) {
    const id = docId(p);
    if (!id) { noId++; continue; }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    const { product, issues } = mapProduct(id, p);
    for (const i of issues) productIssues[i.code] = (productIssues[i.code] ?? 0) + 1;
    if (!product) continue;
    importable++;
    if (product.stock) stockPieces += product.stock;
    const price = Number(product.unitPrice);
    prices.push(price);
    if (price === 0) zeroPriced++;
  }

  const documents: Record<string, unknown> = {};
  for (const c of ARCHIVED_COLLECTIONS) {
    const docs = data[c] ?? [];
    const ids = new Set<string>();
    const dropped: Record<string, number> = {};
    let total = 0;
    let missingAmount = 0;
    let dup = 0;
    let missingId = 0;
    let earliest = null as string | null;
    let latest = null as string | null;
    for (const d of docs) {
      const id = docId(d);
      if (!id) { missingId++; continue; }
      if (ids.has(id)) { dup++; continue; }
      ids.add(id);
      const s = scrubDocument(c, d);
      for (const f of s.droppedFields) dropped[f] = (dropped[f] ?? 0) + 1;
      if (s.amount === null) missingAmount++; else total += s.amount;
      if (s.sourceCreatedAt) { earliest = !earliest || s.sourceCreatedAt < earliest ? s.sourceCreatedAt : earliest; latest = !latest || s.sourceCreatedAt > latest ? s.sourceCreatedAt : latest; }
    }
    documents[c] = { records: docs.length, archivable: ids.size, missingId, duplicateIds: dup, missingAmount, totalAmount: Math.round(total * 10000) / 10000, earliest, latest, droppedFields: dropped };
  }

  return {
    products: {
      records: products.length, importable, missingId: noId, duplicateIds: duplicates, issues: productIssues, openingStockPieces: stockPieces, zeroPriced,
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    },
    categories: { records: (data.categories ?? []).length, note: 'Category names are carried on each product; the collection itself is not imported.' },
    documents,
    notMigrated: Object.fromEntries(present.filter((c) => c in EXCLUDED_COLLECTIONS).map((c) => [c, EXCLUDED_COLLECTIONS[c]])),
    unknownCollections: present.filter((c) => !['products', 'categories', ...ARCHIVED_COLLECTIONS].includes(c as never) && !(c in EXCLUDED_COLLECTIONS)),
    hasAmounts: ARCHIVED_COLLECTIONS.some((c) => (data[c] ?? []).some((d) => toNumber(d[c === 'orders' ? 'totalAmount' : c === 'pos_sales' ? 'finalTotal' : 'amount']) !== null)),
  };
}
