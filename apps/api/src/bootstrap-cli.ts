import { createPool } from './db.js';
import { bootstrapOrganization } from './bootstrap.js';

const [organizationName, adminSubject, adminEmail, adminName] = process.argv.slice(2);
if (!process.env.DATABASE_URL || !organizationName || !adminSubject || !adminEmail || !adminName) {
  console.error('Usage: DATABASE_URL=... npm run bootstrap -- <org name> <idp subject> <email> <display name>');
  process.exit(1);
}
const db = createPool(process.env.DATABASE_URL);
try {
  console.log(await bootstrapOrganization(db, { organizationName, adminSubject, adminEmail, adminName }));
} finally {
  await db.end();
}
