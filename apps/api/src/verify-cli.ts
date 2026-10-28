import { verifyDatabase } from './backup-verify.js';
import { createPool } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (the restored copy to check)');
  process.exit(2);
}
const db = createPool(url, { max: 1 });
try {
  const v = await verifyDatabase(db);
  for (const c of v.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(`rows: ${Object.entries(v.counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  if (!v.ok) process.exit(1);
} finally {
  await db.end();
}
