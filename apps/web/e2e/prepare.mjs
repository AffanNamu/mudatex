// Gives the browser tests a clean database: drops everything, migrates, creates the organization and its administrator.
// Run from apps/web by the Playwright web server command, after `npm run build` in apps/api.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../../api');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (!/e2e|test/i.test(new URL(url).pathname)) throw new Error(`Refusing to reset ${new URL(url).pathname}: the database name must contain "e2e" or "test"`);

const { createPool } = await import(`${api}/dist/db.js`);
const { bootstrapOrganization } = await import(`${api}/dist/bootstrap.js`);
const db = createPool(url);
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
execFileSync('node', [`${api}/dist/migrate-cli.js`], { stdio: 'inherit', env: process.env, cwd: api });
await bootstrapOrganization(db, { organizationName: 'E2E Textiles', adminSubject: 'e2e-admin', adminEmail: 'admin@e2e.test', adminName: 'Ada Admin' });
await db.end();
