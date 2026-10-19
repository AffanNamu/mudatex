import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVED_COLLECTIONS, MASTER_COLLECTIONS } from './scrub.js';

export type Doc = Record<string, unknown>;
export type SourceData = Record<string, Doc[]>;

const WANTED = [...MASTER_COLLECTIONS, ...ARCHIVED_COLLECTIONS];

/**
 * Reads a directory of exports: `<collection>.ndjson` (one JSON object per line, as written by the export script)
 * or `<collection>.json` (an array). Only collections the migration uses are read; others are listed so the report can
 * say they were deliberately left out.
 */
export async function readExport(dir: string): Promise<{ data: SourceData; present: string[] }> {
  const files = await readdir(dir);
  const present: string[] = [];
  const data: SourceData = {};
  for (const f of files) {
    const m = f.match(/^(.+)\.(ndjson|json)$/);
    if (!m) continue;
    const [, name, ext] = m as unknown as [string, string, string];
    present.push(name);
    if (!WANTED.includes(name as never)) continue;
    const text = await readFile(path.join(dir, f), 'utf8');
    const docs: Doc[] = ext === 'json'
      ? (JSON.parse(text) as Doc[])
      : text.split('\n').filter((l) => l.trim()).map((l, i) => {
          try { return JSON.parse(l) as Doc; } catch { throw new Error(`${f}: line ${i + 1} is not valid JSON`); }
        });
    if (!Array.isArray(docs)) throw new Error(`${f}: expected an array of documents`);
    data[name] = docs;
  }
  return { data, present: present.sort() };
}

/** The id a Sakash document is known by, or null when it has none. */
export const docId = (d: Doc): string | null => {
  const id = d.id;
  return typeof id === 'string' && id.trim() ? id.trim() : typeof id === 'number' ? String(id) : null;
};
