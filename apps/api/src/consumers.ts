import { posRevenueConsumer } from './accounting/pos-posting.js';
import type { InternalConsumer } from './events/dispatcher.js';

/** Internal event consumers. Registered here so the API and the standalone worker run the same set. */
export function allConsumers(): InternalConsumer[] {
  return [posRevenueConsumer];
}
