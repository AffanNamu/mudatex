import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import { readOrder } from '../shop/orders.js';
import { orderCopy } from './order-copy.js';

export type TextOutcome = 'ok' | 'failed';
/** Sends one text message. `to` is digits with the country code and no plus sign (for example 2348012345678). */
export interface Texter { send(to: string, text: string): Promise<TextOutcome> }

/**
 * Termii (a Nigerian messaging provider). Written from its public API description and NOT yet tried against a live account:
 * check the first real message, and the request shape in docs/operations/SMS.md, before relying on it.
 */
export function createTermii(o: { apiKey: string; senderId: string; baseUrl?: string; channel?: 'generic' | 'dnd' | 'whatsapp'; fetch?: typeof fetch }): Texter {
  const f = o.fetch ?? fetch;
  return {
    async send(to, text) {
      try {
        const res = await f(`${(o.baseUrl ?? 'https://api.ng.termii.com').replace(/\/$/, '')}/api/sms/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to, from: o.senderId, sms: text, type: 'plain', channel: o.channel ?? 'generic', api_key: o.apiKey }),
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok ? 'ok' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}

export function texterFromConfig(c: { TERMII_API_KEY?: string; TERMII_SENDER_ID?: string; TERMII_BASE_URL?: string; TERMII_CHANNEL?: 'generic' | 'dnd' | 'whatsapp' }): Texter | undefined {
  return c.TERMII_API_KEY && c.TERMII_SENDER_ID ? createTermii({ apiKey: c.TERMII_API_KEY, senderId: c.TERMII_SENDER_ID, baseUrl: c.TERMII_BASE_URL, channel: c.TERMII_CHANNEL }) : undefined;
}

/** A phone number as the provider wants it: digits only, with the country code. Null if it cannot be one. */
export function smsNumber(raw: string | null | undefined, defaultCountryCode = '234'): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCountryCode + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}

/** The few moments worth a text: money received, sent, delivered. Everything else stays in the app and email. */
export const SMS_EVENTS = ['order.payment', 'order.ship', 'order.deliver'];

export function renderOrderSms(eventType: string, order: { orderNo: string }, store: { name: string; siteUrl: string | null }, lang?: string | null): string | null {
  const m = SMS_EVENTS.includes(eventType) ? orderCopy(lang).events[eventType]?.(order) : undefined;
  if (!m) return null;
  return `${store.name}: ${m.subject}.${store.siteUrl ? ` ${store.siteUrl}/orders/${order.orderNo}` : ''}`;
}

/** Texts shoppers who asked for it when their order is paid, sent or delivered. Once per event. */
export function orderSmsConsumer(texter: Texter): InternalConsumer {
  return {
    name: 'order-sms',
    patterns: SMS_EVENTS,
    async handle(db: Db, event: DomainEvent) {
      const found = await db.query<{ storefront_id: string; language: string; sms_opt_in: boolean }>(
        'SELECT o.storefront_id, c.language, c.sms_opt_in FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [event.aggregateId]);
      const row = found.rows[0];
      if (!row?.sms_opt_in) return;
      const order = await readOrder(db, { id: event.aggregateId, organizationId: event.organizationId });
      const to = smsNumber((order.contact as { phone?: string | null }).phone);
      if (!to) return;
      const sf = await db.query<{ name: string; site_url: string | null }>('SELECT name, site_url FROM storefronts WHERE id = $1', [row.storefront_id]);
      const text = renderOrderSms(event.type, order, { name: sf.rows[0]!.name, siteUrl: sf.rows[0]!.site_url }, row.language);
      if (!text) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'sms', to, text.slice(0, 200)]);
        if (!first.rowCount) return;
        if ((await texter.send(to, text)) === 'failed') throw new Error('text message not accepted by the provider');
      });
    },
  };
}
