import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import type { Mail, Mailer } from './mailer.js';
import { readOrder } from '../shop/orders.js';
import { orderCopy, ORDER_EVENT_TYPES } from './order-copy.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (minor: number, currency: string, minorUnit: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(minor / 10 ** minorUnit);

interface Store { name: string; siteUrl: string | null; contact: Record<string, string | undefined> }

/** The sentence a customer is told for an order event, or null when they are not told about it. */
export const orderMessage = (eventType: string, order: any, _store: Store, lang?: string | null) => orderCopy(lang).events[eventType]?.(order) ?? null;
export const ORDER_EVENTS = ORDER_EVENT_TYPES;

export function renderOrderEmail(eventType: string, order: any, store: Store, lang?: string | null): Mail | null {
  const c = orderCopy(lang);
  const m = c.events[eventType]?.(order);
  if (!m) return null;
  const fmt = (n: number) => money(n, order.currency, order.minorUnit);
  const link = store.siteUrl ? `${store.siteUrl}/orders/${order.orderNo}` : null;
  const lines = (order.lines as any[]).map((l) => ({ title: l.title as string, qty: String(l.quantity).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), total: fmt(l.totalMinor) }));
  const bank = eventType === 'order.place' && order.paymentMethod === 'bank_transfer' && store.contact.accountNumber
    ? [c.bankPay(fmt(order.totalMinor), store.contact.bankName ?? c.ourBank, store.contact.accountName ?? store.name, store.contact.accountNumber), c.bankRef(order.orderNo, new Date(order.expiresAt).toUTCString())]
    : [];
  const text = [
    c.hello(order.contact.name), '', m.lead, '', ...bank, ...(bank.length ? [''] : []),
    c.order(order.orderNo), ...lines.map((l) => `- ${l.title} x ${l.qty}: ${l.total}`),
    `${c.delivery}: ${order.deliveryFeeMinor === 0 ? c.free : fmt(order.deliveryFeeMinor)}`, `${c.total}: ${fmt(order.totalMinor)}`, '',
    ...(link ? [`${c.view}: ${link}`, ''] : []), `${store.name}`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1d1b19">
<h2 style="font-family:Georgia,serif">${esc(store.name)}</h2>
<p>${esc(c.hello(order.contact.name))}</p><p>${esc(m.lead)}</p>
${bank.map((b) => `<p style="background:#f3e6c8;padding:12px;border-radius:8px">${esc(b)}</p>`).join('')}
<table style="width:100%;border-collapse:collapse"><caption style="text-align:left;font-weight:600;padding-bottom:6px">${esc(c.order(order.orderNo))}</caption>
${lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e4ddcf">${esc(l.title)} × ${esc(l.qty)}</td><td style="text-align:right;border-bottom:1px solid #e4ddcf">${esc(l.total)}</td></tr>`).join('')}
<tr><td style="padding:6px 0">${esc(c.delivery)}</td><td style="text-align:right">${order.deliveryFeeMinor === 0 ? esc(c.free) : esc(fmt(order.deliveryFeeMinor))}</td></tr>
<tr><td style="padding:6px 0"><strong>${esc(c.total)}</strong></td><td style="text-align:right"><strong>${esc(fmt(order.totalMinor))}</strong></td></tr></table>
${link ? `<p><a href="${esc(link)}">${esc(c.view)}</a></p>` : ''}</div>`;
  return { to: order.contact.email, subject: m.subject, text, html };
}

/** Emails the customer when their order changes. Safe to retry: a message is sent once per event. */
export function orderEmailConsumer(mailer: Mailer): InternalConsumer {
  return {
    name: 'order-emails',
    patterns: ORDER_EVENT_TYPES,
    async handle(db: Db, event: DomainEvent) {
      const found = await db.query<{ storefront_id: string; language: string }>(
        'SELECT o.storefront_id, c.language FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1',
        [event.aggregateId],
      );
      if (!found.rows[0]) return;
      const order = await readOrder(db, { id: event.aggregateId, organizationId: event.organizationId });
      const sf = await db.query<{ name: string; site_url: string | null; contact: Record<string, string> }>('SELECT name, site_url, contact FROM storefronts WHERE id = $1', [found.rows[0].storefront_id]);
      const mail = renderOrderEmail(event.type, order, { name: sf.rows[0]!.name, siteUrl: sf.rows[0]!.site_url, contact: sf.rows[0]!.contact }, found.rows[0].language);
      if (!mail?.to) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'email', mail.to, mail.subject]);
        if (!first.rowCount) return; // already sent for this event
        await mailer.send(mail); // if this throws, the log row rolls back and the delivery is retried
      });
    },
  };
}
