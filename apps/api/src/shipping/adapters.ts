/**
 * A connector to one delivery company's own system. The pipeline (carriers, shipments, tracking events, the customer's
 * tracking page) does not care which company is behind it; a connector only translates. Add one module per company, once
 * the business has an account and the company's API documentation, and register it in `ADAPTERS` below.
 */
export interface Parcel {
  orderNo: string;
  recipient: { name: string; phone: string; line1: string; line2: string | null; city: string; state: string; countryCode: string };
  items: { title: string; quantity: string }[];
}

export interface TrackedEvent {
  /** The company's own word for the stage; it is mapped through the carrier's status map. */
  status: string;
  description?: string;
  location?: string;
  occurredAt?: Date | string;
  /** A stable id from the company, so the same update arriving twice is recorded once. */
  eventId?: string;
}

export interface CarrierAdapter {
  key: string;
  /**
   * Books the parcel with the company and returns its tracking number. Called before the order is marked as sent, so it
   * must be safe to call again for the same order number (use it as the company's own reference).
   */
  book?(parcel: Parcel, credentials: Record<string, string>): Promise<{ trackingRef: string; externalId?: string; labelUrl?: string; eta?: string }>;
  /** Asks the company where the parcel is now. */
  track?(shipment: { trackingRef: string; externalId: string | null }, credentials: Record<string, string>): Promise<{ events: TrackedEvent[]; eta?: string }>;
}

export type AdapterRegistry = Record<string, CarrierAdapter>;

/** Connectors that ship with Mudatex. None yet: the first one is added when the first delivery company is signed up. */
export const ADAPTERS: AdapterRegistry = {};
