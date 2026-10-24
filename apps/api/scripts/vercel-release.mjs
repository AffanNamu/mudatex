// Runs after the build on Vercel. Applies pending database migrations for production deployments only, so a failed
// migration fails the deployment and the previous version keeps serving. Preview deployments never touch the database.
import { spawnSync } from 'node:child_process';

const env = process.env.VERCEL_ENV;
if (env !== 'production') {
  console.log(`Skipping migrations (VERCEL_ENV=${env ?? 'unset'}).`);
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set for the Production environment; cannot apply migrations.');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['dist/migrate-cli.js'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
