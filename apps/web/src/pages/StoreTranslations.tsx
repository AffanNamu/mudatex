import { useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

interface Row { entityType: 'store' | 'department' | 'product'; entityId: string; lang: 'fr' | 'ha'; field: string; value: string }
interface Item { key: string; entityType: Row['entityType']; entityId: string; field: 'tagline' | 'name' | 'title' | 'description'; label: string; source: string; long: boolean }

const LANGS = [['fr', 'French'], ['ha', 'Hausa']] as const;
const keyOf = (type: string, id: string, field: string) => `${type}/${id}/${field}`;

/** The shop's wording in another language. Blank means "show the English"; nothing here changes prices or stock. */
export function Translations({ store, depts }: { store: { id: string; tagline: string | null }; depts: { id: string; name: string }[] }) {
  const published = useLoad<{ id: string; title: string; description: string | null; published: boolean }[]>(`/v1/storefronts/${store.id}/products`);
  const saved = useLoad<Row[]>(`/v1/storefronts/${store.id}/translations`);
  const [lang, setLang] = useState<'fr' | 'ha'>('fr');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState('');

  const items = useMemo<Item[]>(() => [
    ...(store.tagline ? [{ key: keyOf('store', store.id, 'tagline'), entityType: 'store' as const, entityId: store.id, field: 'tagline' as const, label: 'Tagline', source: store.tagline, long: false }] : []),
    ...depts.map((d) => ({ key: keyOf('department', d.id, 'name'), entityType: 'department' as const, entityId: d.id, field: 'name' as const, label: `Department: ${d.name}`, source: d.name, long: false })),
    ...(published.data ?? []).flatMap((p) => [
      { key: keyOf('product', p.id, 'title'), entityType: 'product' as const, entityId: p.id, field: 'title' as const, label: `Product: ${p.title}`, source: p.title, long: false },
      ...(p.description ? [{ key: keyOf('product', p.id, 'description'), entityType: 'product' as const, entityId: p.id, field: 'description' as const, label: `Description of ${p.title}`, source: p.description, long: true }] : []),
    ]),
  ], [store, depts, published.data]);

  const savedFor = useMemo(() => new Map((saved.data ?? []).filter((r) => r.lang === lang).map((r) => [keyOf(r.entityType, r.entityId, r.field), r.value])), [saved.data, lang]);
  // Start the boxes from what is saved, but only when what is saved actually changes: a reload that brings the same
  // words back must not wipe what the person is typing.
  const signature = JSON.stringify([...savedFor].sort());
  useEffect(() => { setDraft(Object.fromEntries(savedFor)); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOk(''); }, [lang]);

  const changed = items.filter((i) => (draft[i.key] ?? '').trim() !== (savedFor.get(i.key) ?? ''));
  const save = async () => {
    setBusy(true); setError(null); setOk('');
    try {
      const r = await api<{ saved: number; removed: number }>(`/v1/storefronts/${store.id}/translations`, {
        method: 'PUT',
        body: { lang, entries: changed.map((i) => ({ entityType: i.entityType, entityId: i.entityId, field: i.field, value: (draft[i.key] ?? '').trim() || null })) },
      });
      setOk(`Saved ${r.saved}${r.removed ? `, cleared ${r.removed}` : ''}.`);
      saved.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    // Opening the panel reloads what it lists, so products published a moment ago are there.
    <details className="panel" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) { published.reload(); saved.reload(); } }}>
      <summary>Translations (French and Hausa)</summary>
      <p className="muted">Shoppers who choose French or Hausa see these words for the store tagline, departments and products. Leave a box empty to show the English. Have a native speaker check Hausa before it goes live.</p>
      <Field label="Language"><select value={lang} onChange={(e) => setLang(e.target.value as 'fr' | 'ha')}>{LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
      {(saved.loading || published.loading) && !saved.data && <Loading what="translations" />}
      <ErrorBanner error={saved.error ?? published.error ?? error} />
      {items.length === 0 && !saved.loading && <Notice>Add a tagline, departments or published products first.</Notice>}
      <div className="stack">
        {items.map((i) => (
          <div key={i.key} className="card">
            <p className="small muted" style={{ margin: 0 }}>{i.label}</p>
            <p className="small" style={{ margin: '2px 0 8px', whiteSpace: 'pre-line' }}>{i.source.length > 240 ? `${i.source.slice(0, 240)}…` : i.source}</p>
            {i.long
              ? <textarea aria-label={`${i.label} in ${lang === 'fr' ? 'French' : 'Hausa'}`} rows={3} maxLength={5000} value={draft[i.key] ?? ''} onChange={(e) => setDraft({ ...draft, [i.key]: e.target.value })} />
              : <input aria-label={`${i.label} in ${lang === 'fr' ? 'French' : 'Hausa'}`} maxLength={i.field === 'title' ? 160 : i.field === 'name' ? 80 : 200} value={draft[i.key] ?? ''} onChange={(e) => setDraft({ ...draft, [i.key]: e.target.value })} />}
          </div>
        ))}
      </div>
      {items.length > 0 && <div className="row-end"><button className="btn btn-primary" disabled={busy || changed.length === 0} onClick={() => void save()}>{busy ? 'Saving…' : `Save ${changed.length ? `(${changed.length})` : ''}`}</button></div>}
      {ok && <Notice tone="ok">{ok}</Notice>}
    </details>
  );
}
