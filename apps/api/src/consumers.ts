import { posRevenueConsumer } from './accounting/pos-posting.js';
import type { InternalConsumer } from './events/dispatcher.js';
import type { Mailer } from './notify/mailer.js';
import { orderPushConsumer, type Pusher } from './notify/push.js';
import { orderEmailConsumer } from './notify/order-emails.js';
import { quoteEmailConsumer } from './notify/quote-emails.js';
import { returnEmailConsumer } from './notify/return-emails.js';

/** Internal event consumers. Registered here so the API and the standalone worker run the same set. */
export function allConsumers(mailer?: Mailer, pusher?: Pusher): InternalConsumer[] {
  return [posRevenueConsumer, ...(mailer ? [orderEmailConsumer(mailer), quoteEmailConsumer(mailer), returnEmailConsumer(mailer)] : []), ...(pusher ? [orderPushConsumer(pusher)] : [])];
}
