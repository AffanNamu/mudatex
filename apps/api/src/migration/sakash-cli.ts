import { createPool } from '../db.js';
import { importConfig } from './sakash/config.js';
import { profile } from './sakash/profile.js';
import { reconcile } from './sakash/reconcile.js';
import { readExport } from './sakash/source.js';
import { runImport } from './sakash/importer.js';
import { readFile } from 'node:fs/promises';

const USAGE = `Usage: node dist/migration/sakash-cli.js <profile|plan|import|reconcile> --input <export dir> [--config <file>] [--update-changed] [--json]
  profile    what is in the export and what is wrong with it (no database needed)
  plan       run the whole import, report, and roll back (nothing is written)
  import     apply the import (safe to repeat)
  reconcile  compare the export with what Mudatex holds`;

const args = process.argv.slice(2);
const command = args[0];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const input = opt('input');
if (!command || !['profile', 'plan', 'import', 'reconcile'].includes(command) || !input) { console.error(USAGE); process.exit(2); }

// Operators get a plain message, not a stack trace. Add --debug to see the stack.
const fail = (err: unknown): never => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (flag('debug') && err instanceof Error) console.error(err.stack);
  process.exit(1);
};
process.on('unhandledRejection', fail);

const { data, present } = await readExport(input).catch((e): never => fail(e));
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));

if (command === 'profile') {
  show(profile(data, present));
  process.exit(0);
}

const cfgPath = opt('config');
const url = process.env.DATABASE_URL;
if (!cfgPath || !url) { console.error('--config and DATABASE_URL are required for this command\n' + USAGE); process.exit(2); }
const describeConfigError = (e: unknown): Error => {
  if (e instanceof SyntaxError) return new Error(`${cfgPath} is not valid JSON: ${e.message}`);
  if (e instanceof Error && e.name === 'ZodError') {
    const issues = (e as unknown as { issues: { path: (string | number)[]; message: string }[] }).issues;
    return new Error(`${cfgPath} is not a valid configuration:\n${issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return e instanceof Error ? e : new Error(String(e));
};
const cfg = await readFile(cfgPath, 'utf8')
  .then((t) => importConfig.parse(JSON.parse(t)))
  .catch((e): never => fail(describeConfigError(e)));
const db = createPool(url, { max: 4 });
try {
  if (command === 'reconcile') {
    const r = await reconcile(db, cfg, data);
    for (const c of r.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: expected ${c.expected}, found ${c.actual}`);
    for (const c of r.checks.filter((x) => !x.ok && x.detail)) for (const d of c.detail!) console.log(`       ${d}`);
    console.log(r.matched ? '\nReconciled: every check matches.' : '\nNOT reconciled: investigate the failures above before relying on the migrated data.');
    process.exitCode = r.matched ? 0 : 1;
  } else {
    const report = await runImport(db, cfg, data, present, { dryRun: command === 'plan', updateChanged: flag('update-changed') });
    if (flag('json')) show(report);
    else {
      console.log(`${report.dryRun ? 'PLAN (nothing written)' : 'IMPORTED'} run ${report.runId}`);
      for (const [name, c] of Object.entries(report.collections)) console.log(`  ${name}: ${c.source} in source, ${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.failed} failed${c.changedNotApplied ? `, ${c.changedNotApplied} changed (not applied)` : ''}${c.note ? ` — ${c.note}` : ''}`);
      console.log(`  opening stock: ${report.openingStock.pieces} pieces across ${report.openingStock.products} products`);
      const byCode = report.exceptions.reduce<Record<string, number>>((a, e) => { const k = `${e.severity}:${e.collection}:${e.code}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
      console.log(`  exceptions: ${report.exceptions.length}`);
      for (const [k, n] of Object.entries(byCode)) console.log(`    ${n} x ${k}`);
      for (const [c, why] of Object.entries(report.notMigrated)) console.log(`  not migrated: ${c} — ${why}`);
    }
  }
} catch (err) {
  await db.end().catch(() => {});
  fail(err);
} finally {
  await db.end().catch(() => {});
}
