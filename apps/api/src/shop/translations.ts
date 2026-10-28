import type { Db } from '../db.js';

export const SHOP_LANGUAGES = ['en', 'fr', 'ha'] as const;
export type ShopLanguage = (typeof SHOP_LANGUAGES)[number];
export const TRANSLATED = ['fr', 'ha'] as const;

/** { fr: { title: '…', description: '…' }, ha: { … } }: only the languages and fields that have been written. */
export type I18n = Partial<Record<(typeof TRANSLATED)[number], Record<string, string>>>;

/** Translations for some entities of one storefront, keyed by entity id. */
export async function loadI18n(db: Pick<Db, 'query'>, storefrontId: string, type: 'store' | 'department' | 'product', ids: string[]): Promise<Map<string, I18n>> {
  const out = new Map<string, I18n>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ entity_id: string; lang: 'fr' | 'ha'; field: string; value: string }>(
    `SELECT entity_id, lang, field, value FROM content_translations WHERE storefront_id = $1 AND entity_type = $2 AND entity_id = ANY($3::uuid[])`,
    [storefrontId, type, ids],
  );
  for (const r of rows) {
    const entry = out.get(r.entity_id) ?? {};
    (entry[r.lang] ??= {})[r.field] = r.value;
    out.set(r.entity_id, entry);
  }
  return out;
}

/** `undefined` rather than `{}` when nothing is translated, so untranslated shops send no extra bytes. */
export const orNothing = (i: I18n | undefined) => (i && Object.keys(i).length ? i : undefined);
