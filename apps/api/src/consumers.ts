import { posRevenueConsumer } from './accounting/pos-posting.js';
import type { InternalConsumer } from './events/dispatcher.js';
import type { Mailer } from './notify/mailer.js';
import { orderEmailConsumer } from './notify/order-emails.js';

/** Internal event consumers. Registered here so the API and the standalone worker run the same set. */
export function allConsumers(mailer?: Mailer): InternalConsumer[] {
  return [posRevenueConsumer, ...(mailer ? [orderEmailConsumer(mailer)] : [])];
}
