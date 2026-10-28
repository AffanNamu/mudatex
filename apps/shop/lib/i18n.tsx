'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './messages/en';
import { fr } from './messages/fr';
import { ha } from './messages/ha';

export type Lang = 'en' | 'fr' | 'ha';
export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'ha', label: 'Hausa' },
];

const TABLES: Record<Lang, Record<MessageKey, string>> = { en, fr, ha };
const KEY = 'mudatex.lang';

export type Vars = Record<string, string | number>;

/** Looks a message up (English if a language lacks it, the key itself as a last resort) and fills in {placeholders}. */
export function translate(lang: Lang, key: MessageKey | (string & {}), vars?: Vars): string {
  const table = TABLES[lang] as Record<string, string>;
  const text = table[key] ?? (en as Record<string, string>)[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

/** Picks "<key>.one" or "<key>.other" for a count. */
export const plural = (key: string, n: number) => `${key}.${n === 1 ? 'one' : 'other'}`;

export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'fr' || v === 'ha';

/** The first supported language in the browser's preference list, else English. */
export function detectLang(preferred: readonly string[] | undefined): Lang {
  for (const p of preferred ?? []) {
    const base = p.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

// Code outside React (error messages thrown from the sign-in helper) reads the current language from here.
let current: Lang = 'en';
export const tr = (key: MessageKey | (string & {}), vars?: Vars) => translate(current, key, vars);

interface I18nValue { lang: Lang; setLang(l: Lang): void; t(key: MessageKey | (string & {}), vars?: Vars): string }
const Ctx = createContext<I18nValue>({ lang: 'en', setLang: () => undefined, t: (k, v) => translate('en', k, v) });

/**
 * The server always renders English, so every visitor gets the same cached page; the shopper's language is applied as
 * soon as the page loads: their saved choice, else their browser's language when we have it.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* optional */ }
    setLangState(isLang(saved) ? saved : detectLang(navigator.languages ?? [navigator.language]));
  }, []);
  useEffect(() => { current = lang; document.documentElement.lang = lang; }, [lang]);

  const setLang = useCallback((l: Lang) => { setLangState(l); try { localStorage.setItem(KEY, l); } catch { /* optional */ } }, []);
  const value = useMemo<I18nValue>(() => ({ lang, setLang, t: (k, v) => translate(lang, k, v) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** A translated text node, usable from server components. */
export function T({ k, vars }: { k: MessageKey | (string & {}); vars?: Vars }) {
  return <>{useI18n().t(k, vars)}</>;
}
