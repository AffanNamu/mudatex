import { z } from 'zod';

export const importConfig = z.object({
  sourceSystem: z.string().default('sakash'),
  /** An existing active Mudatex user who is recorded as the author of the import. */
  actorEmail: z.string().email(),
  legalEntityId: z.string().uuid(),
  /** Where opening stock is received. Must be a branch, warehouse or storage location of the legal entity. */
  locationId: z.string().uuid(),
  /** Optional: sets each product's price on this list, effective from the import. */
  priceListId: z.string().uuid().optional(),
  /** Sakash counts stock in whole items and prices per item, so the default unit is a piece. */
  baseUnit: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/).default('pcs'),
    name: z.string().default('Piece'),
    kind: z.enum(['discrete', 'decimal']).default('discrete'),
    precision: z.number().int().min(0).max(6).default(0),
  }).prefault({}),
});
export type ImportConfig = z.infer<typeof importConfig>;
