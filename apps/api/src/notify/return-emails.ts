import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import type { Mail, Mailer } from './mailer.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (minor: number, currency: string, minorUnit: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(minor / 10 ** minorUnit);

interface Copy {
  hello(n: string): string; subject(no: string, ok: boolean): string; approved(no: string): string; declined(no: string): string;
  refund(amount: string): string; bring(address: string): string; reason: string; thanks: string;
}
const en: Copy = {
  hello: (n) => `Hello ${n},`, subject: (no, ok) => `Your return for order ${no} was ${ok ? 'approved' : 'declined'}`,
  approved: (no) => `We have approved the return you asked for on order ${no}.`, declined: (no) => `We are sorry: we could not accept the return you asked for on order ${no}.`,
  refund: (a) => `A refund of ${a} is being processed; you will hear from us when it is paid.`, bring: (a) => `Please bring or send the goods back to: ${a}`, reason: 'Reason:', thanks: 'Thank you.',
};
const fr: Copy = {
  hello: (n) => `Bonjour ${n},`, subject: (no, ok) => `Votre retour pour la commande ${no} a été ${ok ? 'accepté' : 'refusé'}`,
  approved: (no) => `Nous avons accepté le retour que vous avez demandé pour la commande ${no}.`, declined: (no) => `Désolés : nous n’avons pas pu accepter le retour demandé pour la commande ${no}.`,
  refund: (a) => `Un remboursement de ${a} est en cours de traitement ; nous vous écrirons quand il sera payé.`, bring: (a) => `Merci de rapporter ou d’envoyer les articles à : ${a}`, reason: 'Motif :', thanks: 'Merci.',
};
// First draft; a Hausa speaker should read it before launch (see docs/operations/SHOP_LANGUAGES.md).
const ha: Copy = {
  hello: (n) => `Sannu ${n},`, subject: (no, ok) => `An ${ok ? 'amince da' : 'ƙi amincewa da'} dawo da kayanku na odar ${no}`,
  approved: (no) => `Mun amince da dawo da kayan da kuka nema a odar ${no}.`, declined: (no) => `Yi haƙuri: ba mu iya amincewa da dawo da kayan da kuka nema a odar ${no} ba.`,
  refund: (a) => `Ana shirya mayar muku da kuɗi ${a}; za mu sanar da ku idan an biya.`, bring: (a) => `Ku kawo ko ku aiko mana da kayan zuwa: ${a}`, reason: 'Dalili:', thanks: 'Mun gode.',
};
const COPY: Record<string, Copy> = { en, fr, ha };

export interface ReturnMail { orderNo: string; name: string; email: string; ok: boolean; note: string | null; refundMinor: number; currency: string; minorUnit: number; storeName: string; address: string | null; language: string }

export function renderReturnEmail(r: ReturnMail): Mail {
  const c = COPY[r.language] ?? en;
  const lines = [c.hello(r.name), '', r.ok ? c.approved(r.orderNo) : c.declined(r.orderNo)];
  if (r.ok && r.refundMinor > 0) lines.push(c.refund(money(r.refundMinor, r.currency, r.minorUnit)));
  if (r.ok && r.address) lines.push(c.bring(r.address));
  if (r.note) lines.push(`${c.reason} ${r.note}`);
  lines.push('', c.thanks, r.storeName);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1d1b19"><h2 style="font-family:Georgia,serif">${esc(r.storeName)}</h2>${lines.slice(0, -3).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('')}<p>${esc(c.thanks)}</p></div>`;
  return { to: r.email, subject: c.subject(r.orderNo, r.ok), text: lines.join('\n'), html };
}

/** Tells the buyer what was decided about their return. Once per decision. */
export function returnEmailConsumer(mailer: Mailer): InternalConsumer {
  return {
    name: 'return-emails',
    patterns: ['order.return_decided'],
    async handle(db: Db, event: DomainEvent) {
      const { rows } = await db.query(
        `SELECT o.order_no AS "orderNo", o.contact->>'name' AS name, o.contact->>'email' AS email, (r.status = 'approved') AS ok, r.decision_note AS note, r.refund_minor::float8 AS "refundMinor",
                o.currency, cu.minor_unit AS "minorUnit", s.name AS "storeName", s.contact->>'address' AS address, c.language
           FROM order_returns r JOIN sales_orders o ON o.id = r.order_id JOIN currencies cu ON cu.code = o.currency JOIN storefronts s ON s.id = o.storefront_id JOIN customers c ON c.id = r.customer_id
          WHERE r.id = $1 AND r.status IN ('approved', 'rejected')`, [event.aggregateId]);
      if (!rows[0]) return;
      const mail = renderReturnEmail(rows[0]);
      if (!mail.to) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'email', mail.to, mail.subject]);
        if (!first.rowCount) return;
        await mailer.send(mail);
      });
    },
  };
}
