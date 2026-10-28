import webpush from 'web-push';
import type { Db } from '../db.js';
import { withTx } from '../db.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import { readOrder } from '../shop/orders.js';
import { orderMessage, ORDER_EVENTS } from './order-emails.js';

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushMessage { title: string; body: string; url: string; tag: string }
/** 'gone' means the person removed the permission or uninstalled: the subscription should be forgotten. */
export type PushOutcome = 'ok' | 'gone' | 'failed';

export interface Pusher {
  readonly publicKey: string;
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
}

export function createWebPush(keys: { publicKey: string; privateKey: string; subject: string }): Pusher {
  return {
    publicKey: keys.publicKey,
    async send(t, m) {
      try {
        await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(m), {
          vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 3600, timeout: 10_000,
        });
        return 'ok';
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        return code === 404 || code === 410 ? 'gone' : 'failed';
      }
    },
  };
}

export function pusherFromConfig(c: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }): Pusher | undefined {
  return c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY && c.VAPID_SUBJECT ? createWebPush({ publicKey: c.VAPID_PUBLIC_KEY, privateKey: c.VAPID_PRIVATE_KEY, subject: c.VAPID_SUBJECT }) : undefined;
}

/** Tells a shopper's phone when their order changes. Each event is pushed once; dead subscriptions are removed. */
export function orderPushConsumer(pusher: Pusher): InternalConsumer {
  return {
    name: 'order-push',
    patterns: ORDER_EVENTS,
    async handle(db: Db, event: DomainEvent) {
      const found = await db.query<{ customer_id: string; storefront_id: string }>('SELECT customer_id, storefront_id FROM sales_orders WHERE id = $1', [event.aggregateId]);
      if (!found.rows[0]) return;
      const subs = await db.query<PushTarget & { id: string }>('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE customer_id = $1', [found.rows[0].customer_id]);
      if (!subs.rowCount) return;
      const order = await readOrder(db, { id: event.aggregateId, organizationId: event.organizationId });
      const sf = await db.query<{ name: string; site_url: string | null; contact: Record<string, string> }>('SELECT name, site_url, contact FROM storefronts WHERE id = $1', [found.rows[0].storefront_id]);
      const msg = orderMessage(event.type, order, { name: sf.rows[0]!.name, siteUrl: sf.rows[0]!.site_url, contact: sf.rows[0]!.contact });
      if (!msg) return;
      await withTx(db, async (tx) => {
        const first = await tx.query('INSERT INTO notification_log (event_id, channel, recipient, subject) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [event.id, 'push', String(found.rows[0]!.customer_id), msg.subject]);
        if (!first.rowCount) return;
        const outcomes: PushOutcome[] = [];
        for (const s of subs.rows) {
          const o = await pusher.send(s, { title: sf.rows[0]!.name, body: msg.lead, url: `/orders/${order.orderNo}`, tag: order.orderNo });
          outcomes.push(o);
          if (o === 'gone') await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
          if (o === 'ok') await tx.query('UPDATE push_subscriptions SET last_success_at = now() WHERE id = $1', [s.id]);
        }
        // If every device failed for a reason that may pass, try the event again later; otherwise we are done.
        if (outcomes.length > 0 && outcomes.every((o) => o === 'failed')) throw new Error('push delivery failed for every device');
      });
    },
  };
}
