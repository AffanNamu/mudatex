import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import { readQuote } from '../trade/quotes.js';
import type { Mail, Mailer } from './mailer.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (minor: number, currency: string, minorUnit: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(minor / 10 ** minorUnit);

interface Copy { hello(n: string): string; subject(no: string, store: string): string; lead(no: string, until: string): string; lines: string; total: string; delivery: string; accept: string; note: string; thanks: string }
const en: Copy = {
  hello: (n) => `Hello ${n},`, subject: (no, s) => `Your quote ${no} from ${s}`,
  lead: (no, until) => `Your quote ${no} is ready. The prices are fixed until ${until}. Open it to accept and place your order.`,
  lines: 'Quoted goods:', total: 'Total goods (tax included)', delivery: 'Delivery is worked out when you choose your address.', accept: 'Open the quote', note: 'Note from the shop:', thanks: 'Thank you for trading with us.',
};
const fr: Copy = {
  hello: (n) => `Bonjour ${n},`, subject: (no, s) => `Votre devis ${no} de ${s}`,
  lead: (no, until) => `Votre devis ${no} est prêt. Les prix sont garantis jusqu’au ${until}. Ouvrez-le pour l’accepter et passer votre commande.`,
  lines: 'Marchandises proposées :', total: 'Total des marchandises (taxes comprises)', delivery: 'La livraison est calculée quand vous choisissez votre adresse.', accept: 'Ouvrir le devis', note: 'Message de la boutique :', thanks: 'Merci de votre confiance.',
};
// First draft; a Hausa speaker should read it before launch (see docs/operations/SHOP_LANGUAGES.md).
const ha: Copy = {
  hello: (n) => `Sannu ${n},`, subject: (no, s) => `Ƙiyasin farashinku ${no} daga ${s}`,
  lead: (no, until) => `Ƙiyasin farashinku ${no} ya shirya. An tsaida farashin har ${until}. Ku buɗe shi don ku amince ku yi oda.`,
  lines: 'Kayan da aka ƙiyasta:', total: 'Jimlar kaya (an haɗa haraji)', delivery: 'Ana lissafa kuɗin isarwa lokacin da kuka zaɓi adireshinku.', accept: 'Buɗe ƙiyasin farashi', note: 'Saƙo daga shagon:', thanks: 'Mun gode da yin kasuwanci da mu.',
};
const COPY: Record<string, Copy> = { en, fr, ha };

export function renderQuoteEmail(q: Awaited<ReturnType<typeof readQuote>>, store: { name: string; siteUrl: string | null }, language: string): Mail {
  const c = COPY[language] ?? en;
  const fmt = (n: number) => money(n, q.currency, q.minorUnit);
  const link = store.siteUrl ? `${store.siteUrl}/quotes/${q.quoteNo}` : null;
  const lines = (q.lines as any[]).map((l) => `- ${l.title} × ${String(l.quantity)}: ${fmt(l.totalMinor)}`);
  const text = [c.hello(q.contactName), '', c.lead(q.quoteNo, q.validUntil), '', c.lines, ...lines, `${c.total}: ${fmt(q.subtotalMinor)}`, c.delivery, '', ...(q.note ? [`${c.note} ${q.note}`, ''] : []), ...(link ? [`${c.accept}: ${link}`, ''] : []), c.thanks, store.name].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1d1b19"><h2 style="font-family:Georgia,serif">${esc(store.name)}</h2>
<p>${esc(c.hello(q.contactName))}</p><p>${esc(c.lead(q.quoteNo, q.validUntil))}</p>
<table style="width:100%;border-collapse:collapse"><caption style="text-align:left;font-weight:600;padding-bottom:6px">${esc(c.lines)}</caption>
${(q.lines as any[]).map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e4ddcf">${esc(l.title)} × ${esc(String(l.quantity))}</td><td style="text-align:right;border-bottom:1px solid #e4ddcf">${esc(fmt(l.totalMinor))}</td></tr>`).join('')}
<tr><td style="padding:6px 0"><strong>${esc(c.total)}</strong></td><td style="text-align:right"><strong>${esc(fmt(q.subtotalMinor))}</strong></td></tr></table>
<p>${esc(c.delivery)}</p>${q.note ? `<p><em>${esc(c.note)} ${esc(q.note)}</em></p>` : ''}${link ? `<p><a href="${esc(link)}">${esc(c.accept)}</a></p>` : ''}<p>${esc(c.thanks)}</p></div>`;
  return { to: q.email, subject: c.subject(q.quoteNo, store.name), text, html };
}

/** Tells the buyer when a quote is sent to them. Once per event. */
export function quoteEmailConsumer(mailer: Mailer): InternalConsumer {
  return {
    name: 'quote-emails',
    patterns: ['quote.send'],
    async handle(db: Db, event: DomainEvent) {
      const q = await readQuote(db, { id: event.aggregateId, organizationId: event.organizationId });
      const extra = await db.query<{ name: string; site_url: string | null; language: string }>(
        `SELECT s.name, s.site_url, c.language FROM quotes q JOIN storefronts s ON s.id = q.storefront_id JOIN customers c ON c.id = q.customer_id WHERE q.id = $1`, [q.id]);
      const mail = renderQuoteEmail(q, { name: extra.rows[0]!.name, siteUrl: extra.rows[0]!.site_url }, extra.rows[0]!.language);
      if (!mail.to) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'email', mail.to, mail.subject]);
        if (!first.rowCount) return;
        await mailer.send(mail);
      });
    },
  };
}
