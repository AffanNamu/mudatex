import { z } from 'zod';
import type { Tx } from '../db.js';
import { convertExact, toScaled } from '../domain/decimal.js';
import { parseQuantity, QuantityError } from '../domain/quantity.js';
import { invalid, notFound } from '../errors.js';

export interface VariantInfo {
  id: string;
  productId: string;
  sku: string;
  tracking: 'none' | 'lot' | 'roll';
  baseUnitId: string;
  baseUnit: { code: string; kind: 'discrete' | 'decimal'; precision: number };
}

export interface LocationInfo {
  id: string;
  legalEntityId: string;
  type: string;
}

// Stock may be held in these location types only.
const STOCK_HOLDING = new Set(['branch', 'warehouse', 'storage_location']);

export const quantityField = z.string().regex(/^\d+(\.\d+)?$/, 'Quantity must be a positive decimal string');
export const uuid = z.string().uuid();

export const lineBody = z.object({
  variantId: uuid,
  lotId: uuid.optional(),
  quantity: quantityField,
  unitId: uuid.optional(),
});
export type LineInput = z.infer<typeof lineBody>;

export async function loadStockLocation(tx: Tx, organizationId: string, id: string): Promise<LocationInfo> {
  const { rows } = await tx.query<{ id: string; legal_entity_id: string; type: string }>(
    `SELECT l.id, l.legal_entity_id, l.type FROM locations l
       JOIN legal_entities e ON e.id = l.legal_entity_id
      WHERE l.id = $1 AND e.organization_id = $2`,
    [id, organizationId],
  );
  const row = rows[0];
  if (!row) throw notFound('Location');
  if (!STOCK_HOLDING.has(row.type)) throw invalid(`A ${row.type} location cannot hold stock`);
  return { id: row.id, legalEntityId: row.legal_entity_id, type: row.type };
}

export async function loadVariant(tx: Tx, organizationId: string, id: string): Promise<VariantInfo> {
  const { rows } = await tx.query<{
    id: string;
    product_id: string;
    sku: string;
    tracking: 'none' | 'lot' | 'roll';
    base_unit_id: string;
    code: string;
    kind: 'discrete' | 'decimal';
    precision: number;
  }>(
    `SELECT v.id, v.product_id, v.sku, v.tracking, p.base_unit_id, u.code, u.kind, u.precision
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.id = p.base_unit_id
      WHERE v.id = $1 AND v.organization_id = $2`,
    [id, organizationId],
  );
  const r = rows[0];
  if (!r) throw notFound('Variant');
  return {
    id: r.id,
    productId: r.product_id,
    sku: r.sku,
    tracking: r.tracking,
    baseUnitId: r.base_unit_id,
    baseUnit: { code: r.code, kind: r.kind, precision: r.precision },
  };
}

/**
 * Turns a user-entered quantity (optionally in another unit) into a positive
 * base-unit decimal string using only the product's explicit conversions.
 */
export async function resolveQuantity(tx: Tx, variant: VariantInfo, quantity: string, unitId?: string): Promise<string> {
  try {
    let base: string;
    if (!unitId || unitId === variant.baseUnitId) {
      base = parseQuantity(quantity, variant.baseUnit);
    } else {
      const { rows } = await tx.query<{ factor: string; code: string; kind: 'discrete' | 'decimal'; precision: number }>(
        `SELECT c.factor, u.code, u.kind, u.precision
           FROM product_unit_conversions c JOIN units u ON u.id = c.from_unit_id
          WHERE c.product_id = $1 AND c.from_unit_id = $2 AND c.to_unit_id = $3`,
        [variant.productId, unitId, variant.baseUnitId],
      );
      const c = rows[0];
      if (!c) throw invalid('No explicit conversion from that unit to the product base unit');
      parseQuantity(quantity, c); // input must respect its own unit's precision
      base = convertExact(quantity, c.factor, variant.baseUnit.precision);
    }
    if (toScaled(base) === 0n) throw invalid('Quantity must be greater than zero');
    return base;
  } catch (err) {
    if (err instanceof QuantityError) throw invalid(err.message);
    throw err;
  }
}

/** Tracked variants need a lot/roll that belongs to them; untracked variants must not name one. */
export async function checkLot(tx: Tx, organizationId: string, variant: VariantInfo, lotId: string | undefined) {
  if (variant.tracking === 'none') {
    if (lotId) throw invalid(`${variant.sku} is not lot or roll tracked`);
    return null;
  }
  if (!lotId) throw invalid(`${variant.sku} is ${variant.tracking}-tracked; lotId is required`);
  const { rows } = await tx.query<{ kind: string }>(
    'SELECT kind FROM stock_lots WHERE id = $1 AND variant_id = $2 AND organization_id = $3',
    [lotId, variant.id, organizationId],
  );
  if (!rows[0]) throw notFound('Lot');
  return lotId;
}

import type { FastifyRequest } from 'fastify';
import { writeAudit } from '../audit.js';
import type { Grants } from '../auth/authorize.js';

export function audit(tx: Tx, req: FastifyRequest, action: string, entityType: string, entityId: string, after?: unknown) {
  return writeAudit(tx, {
    organizationId: req.actor.organizationId,
    actorUserId: req.actor.userId,
    requestId: req.id,
    action,
    entityType,
    entityId,
    after,
  });
}

/** SQL predicate limiting rows to locations covered by the caller's grants. `l` is the locations alias. */
export function scopeFilter(grants: Grants, firstParam: number): { clause: string; params: unknown[] } {
  const n = firstParam;
  return {
    clause: `($${n}::boolean OR l.country_code::text = ANY($${n + 1}::text[]) OR l.legal_entity_id = ANY($${n + 2}::uuid[]) OR l.ancestor_ids && $${n + 3}::uuid[])`,
    params: [grants.group, [...grants.countries], [...grants.legalEntities], [...grants.locations]],
  };
}
