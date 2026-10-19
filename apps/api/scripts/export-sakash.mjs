#!/usr/bin/env node
// Exports the Sakash (PFB) Firestore collections the migration needs, to NDJSON files.
//
//   cd apps/api && npm run build
//   npm install --no-save firebase-admin
//   node scripts/export-sakash.mjs --service-account ./sakash-service-account.json --out ./sakash-export
//
// READ-ONLY: it only calls get(). Personal data is removed at the source with the same allow-list the importer
// uses (customer names, phones, addresses, emails and user ids never reach the files). Products and categories
// are exported as they are. users, admins and device tokens are never read.
// Delete the service-account key and the export directory when you are done.
import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldPath, GeoPoint, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { ARCHIVED_COLLECTIONS, MASTER_COLLECTIONS, scrubDocument } from '../dist/migration/sakash/scrub.js';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const keyPath = opt('service-account');
const out = opt('out');
if (!keyPath || !out) { console.error('Usage: node scripts/export-sakash.mjs --service-account <key.json> --out <dir>'); process.exit(2); }
if (!existsSync(path.resolve('dist/migration/sakash/scrub.js'))) { console.error('Run `npm run build` first.'); process.exit(2); }

initializeApp({ credential: cert(path.resolve(keyPath)) });
const db = getFirestore();
mkdirSync(out, { recursive: true });

// Firestore value types become plain JSON.
const plain = (v) => {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
  if (v && typeof v === 'object' && typeof v.path === 'string' && typeof v.firestore === 'object') return v.path;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return Buffer.isBuffer(v) ? undefined : v;
};

const collections = [...MASTER_COLLECTIONS, ...ARCHIVED_COLLECTIONS];
for (const name of collections) {
  const file = path.join(out, `${name}.ndjson`);
  const stream = createWriteStream(file);
  let count = 0;
  let last = null;
  for (;;) {
    let q = db.collection(name).orderBy(FieldPath.documentId()).limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = { id: doc.id, ...plain(doc.data()) };
      const row = ARCHIVED_COLLECTIONS.includes(name) ? { id: doc.id, ...scrubDocument(name, data).payload } : data;
      stream.write(JSON.stringify(row) + '\n');
      count++;
    }
    last = snap.docs[snap.docs.length - 1];
  }
  await new Promise((r) => stream.end(r));
  console.log(`${name}: ${count} documents -> ${file}`);
}
console.log('\nDone. users, admins and device tokens were not read. Run the profile step next.');
