import { Notice } from '../../components/ui';
import type { Stock } from '../../lib/useStock';

interface CountReply { matched: number; adjustmentId: string | null; differences: { productName: string; lotCode: string | null; counted: string; expected: string; delta: string }[] }

/** What happened to something just submitted: still on the phone, refused, or done (with the server's own answer). */
export function Outcome({ stock, id, kind }: { stock: Stock; id: string | null; kind: 'count' | 'receive' }) {
  if (!id) return null;
  const sent = stock.recent.find((s) => s.item.id === id);
  const waiting = stock.outbox.find((o) => o.id === id);
  if (waiting?.status === 'rejected') return <div role="alert" className="banner banner-error">The server did not accept this: {waiting.reason} It is kept under Waiting so you can read it and discard it.</div>;
  if (waiting) return <Notice tone="warn">Saved on this phone. It will be sent when there is a connection ({stock.sending ? 'sending now…' : 'waiting'}).</Notice>;
  if (!sent) return null;
  if (kind === 'receive') return <Notice tone="ok">Received and added to stock.</Notice>;
  const r = sent.response as CountReply;
  return (
    <Notice tone={r.differences.length ? 'warn' : 'ok'}>
      <strong>Count sent.</strong> {r.matched} matched the books.
      {r.differences.length > 0 && (
        <>
          {' '}{r.differences.length} {r.differences.length === 1 ? 'difference is' : 'differences are'} waiting for a second person to approve; stock does not change until they do.
          <ul className="stock-diffs">
            {r.differences.map((d, i) => <li key={i}>{d.productName}{d.lotCode ? ` · ${d.lotCode}` : ''}: counted {d.counted}, books said {d.expected} ({Number(d.delta) > 0 ? '+' : ''}{d.delta})</li>)}
          </ul>
        </>
      )}
    </Notice>
  );
}
