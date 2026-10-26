import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import type { Mail, Mailer } from './mailer.js';
import { readOrder } from '../shop/orders.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (minor: number, currency: string, minorUnit: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(minor / 10 ** minorUnit);

interface Store { name: string; siteUrl: string | null; contact: Record<string, string | undefined> }

/** Which order events a customer is told about, and the sentence that tells them. */
const MESSAGES: Record<string, (o: any, s: Store) => { subject: string; lead: string } | null> = {
  'order.place': (o) => ({ subject: `We have your order ${o.orderNo}`, lead: o.paymentMethod === 'bank_transfer' ? 'Thank you for your order. Please pay by bank transfer to confirm it.' : 'Thank you for your order. Please complete your card payment to confirm it.' }),
  'order.payment': (o) => ({ subject: `Payment received for ${o.orderNo}`, lead: 'We have received your payment. We will prepare your order now.' }),
  'order.ship': (o) => ({ subject: `Your order ${o.orderNo} is on its way`, lead: o.trackingRef ? `Your order has been sent with ${o.carrier ?? 'our courier'}. Tracking number: ${o.trackingRef}.` : 'Your order has been sent.' }),
  'order.deliver': (o) => ({ subject: `Your order ${o.orderNo} was delivered`, lead: 'Your order has been delivered. We hope you love it — a review helps other shoppers.' }),
  'order.cancel': (o) => ({ subject: `Your order ${o.orderNo} was cancelled`, lead: o.refundDueMinor > 0 ? 'Your order was cancelled. We owe you a refund and will be in touch about it.' : 'Your order was cancelled and nothing has been charged.' }),
  'order.refund_paid': (o) => ({ subject: `Refund sent for ${o.orderNo}`, lead: 'We have sent your refund. Card refunds can take a few working days to show on your statement; bank refunds are usually quicker.' }),
  'order.expire': (o) => ({ subject: `Your order ${o.orderNo} has lapsed`, lead: 'We did not receive payment in time, so the fabric was released. You are welcome to order again.' }),
};

export function renderOrderEmail(eventType: string, order: any, store: Store): Mail | null {
  const m = MESSAGES[eventType]?.(order, store);
  if (!m) return null;
  const fmt = (n: number) => money(n, order.currency, order.minorUnit);
  const link = store.siteUrl ? `${store.siteUrl}/orders/${order.orderNo}` : null;
  const lines = (order.lines as any[]).map((l) => ({ title: l.title as string, qty: String(l.quantity).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), total: fmt(l.totalMinor) }));
  const bank = eventType === 'order.place' && order.paymentMethod === 'bank_transfer' && store.contact.accountNumber
    ? [`Pay ${fmt(order.totalMinor)} to ${store.contact.bankName ?? 'our bank'}, account name ${store.contact.accountName ?? store.name}, account number ${store.contact.accountNumber}.`, `Use ${order.orderNo} as the payment reference. We hold your order until ${new Date(order.expiresAt).toUTCString()}.`]
    : [];
  const text = [
    `Hello ${order.contact.name},`, '', m.lead, '', ...bank, ...(bank.length ? [''] : []),
    `Order ${order.orderNo}`, ...lines.map((l) => `- ${l.title} x ${l.qty}: ${l.total}`),
    `Delivery: ${order.deliveryFeeMinor === 0 ? 'Free' : fmt(order.deliveryFeeMinor)}`, `Total: ${fmt(order.totalMinor)}`, '',
    ...(link ? [`View your order: ${link}`, ''] : []), `${store.name}`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1d1b19">
<h2 style="font-family:Georgia,serif">${esc(store.name)}</h2>
<p>Hello ${esc(order.contact.name)},</p><p>${esc(m.lead)}</p>
${bank.map((b) => `<p style="background:#f3e6c8;padding:12px;border-radius:8px">${esc(b)}</p>`).join('')}
<table style="width:100%;border-collapse:collapse"><caption style="text-align:left;font-weight:600;padding-bottom:6px">Order ${esc(order.orderNo)}</caption>
${lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e4ddcf">${esc(l.title)} × ${esc(l.qty)}</td><td style="text-align:right;border-bottom:1px solid #e4ddcf">${esc(l.total)}</td></tr>`).join('')}
<tr><td style="padding:6px 0">Delivery</td><td style="text-align:right">${order.deliveryFeeMinor === 0 ? 'Free' : esc(fmt(order.deliveryFeeMinor))}</td></tr>
<tr><td style="padding:6px 0"><strong>Total</strong></td><td style="text-align:right"><strong>${esc(fmt(order.totalMinor))}</strong></td></tr></table>
${link ? `<p><a href="${esc(link)}">View your order</a></p>` : ''}</div>`;
  return { to: order.contact.email, subject: m.subject, text, html };
}

/** Emails the customer when their order changes. Safe to retry: a message is sent once per event. */
export function orderEmailConsumer(mailer: Mailer): InternalConsumer {
  return {
    name: 'order-emails',
    patterns: Object.keys(MESSAGES),
    async handle(db: Db, event: DomainEvent) {
      const found = await db.query<{ storefront_id: string }>('SELECT storefront_id FROM sales_orders WHERE id = $1', [event.aggregateId]);
      if (!found.rows[0]) return;
      const order = await readOrder(db, { id: event.aggregateId, organizationId: event.organizationId });
      const sf = await db.query<{ name: string; site_url: string | null; contact: Record<string, string> }>('SELECT name, site_url, contact FROM storefronts WHERE id = $1', [found.rows[0].storefront_id]);
      const mail = renderOrderEmail(event.type, order, { name: sf.rows[0]!.name, siteUrl: sf.rows[0]!.site_url, contact: sf.rows[0]!.contact });
      if (!mail?.to) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'email', mail.to, mail.subject]);
        if (!first.rowCount) return; // already sent for this event
        await mailer.send(mail); // if this throws, the log row rolls back and the delivery is retried
      });
    },
  };
}
