import { describe, expect, it } from 'vitest';
import { detectLang, plural, translate } from '@/lib/i18n';
import { en } from '@/lib/messages/en';
import { fr } from '@/lib/messages/fr';
import { ha } from '@/lib/messages/ha';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];
  for (const [name, table] of [['French', fr], ['Hausa', ha]] as const) {
    it(`${name} has exactly the English keys`, () => {
      expect(Object.keys(table).sort()).toEqual([...keys].sort());
    });
    it(`${name} keeps every {placeholder} of the English text`, () => {
      const bad = keys.filter((k) => JSON.stringify(placeholders(table[k])) !== JSON.stringify(placeholders(en[k])));
      expect(bad).toEqual([]);
    });
    it(`${name} leaves no message empty`, () => {
      expect(keys.filter((k) => !table[k].trim())).toEqual([]);
    });
  }
});

describe('translate', () => {
  it('fills placeholders and falls back to English, then to the key', () => {
    expect(translate('en', 'footer.rights', { year: 2026, name: 'Mudatex' })).toBe('© 2026 Mudatex. All rights reserved.');
    expect(translate('fr', 'shop.pageOf', { page: 2, pages: 5 })).toBe('Page 2 sur 5');
    expect(translate('ha', 'no.such.key')).toBe('no.such.key');
    expect(translate('en', 'shop.count.other', {})).toBe('{n} products');
  });
  it('chooses singular or plural', () => {
    expect(plural('shop.count', 1)).toBe('shop.count.one');
    expect(plural('shop.count', 0)).toBe('shop.count.other');
    expect(plural('shop.count', 12)).toBe('shop.count.other');
  });
});

describe('detectLang', () => {
  it('uses the first supported browser language', () => {
    expect(detectLang(['fr-NG', 'en'])).toBe('fr');
    expect(detectLang(['ha-Latn-NG'])).toBe('ha');
    expect(detectLang(['de-DE', 'ha'])).toBe('ha');
    expect(detectLang(['de'])).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
});
