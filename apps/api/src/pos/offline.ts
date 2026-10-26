import { createHash } from 'node:crypto';
import { can } from '../auth/authorize.js';
import { writeAudit } from '../audit.js';
import { withTx, type Db, type Tx } from '../db.js';
import { fromScaled, toScaled } from '../domain/decimal.js';
import { AppError } from '../errors.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { priceSaleLines, saleTotals } from './pricing.js';

export interface OfflineSaleInput {
  clientSaleId: string;
  registerId: string;
  sessionId: string;
  soldAt: string;
  deviceId?: string;
  localReceiptNo: string;
  lines: { variantId: string; quantity: string; discount?: { type: 'percent'; basisPoints: number } | { type: 'amount'; amountMinor: number } }[];
  /** What the till showed the customer, and the cash it took. Used only to measure variance; never trusted for money. */
  tillTotalMinor: number;
  tenderedMinor: number;
}

export type OfflineResult =
  | { clientSaleId: string; status: 'created' | 'duplicate'; saleId: string; receiptNumber: string; totalMinor: number; varianceMinor: number; shortages: number }
  | { clientSaleId: string; status: 'rejected'; reason: string };

const reject = (clientSaleId: string, reason: string): OfflineResult => ({ clientSaleId, status: 'rejected', reason });

/** The packs and sales older than this are not accepted for pricing guarantees; the till refuses to use an older pack. */
export const PACK_MAX_AGE_HOURS = 24;

class Rejection extends Error {}

/** Records one offline sale in its own transaction. Anything the server cannot accept comes back as a reason, not an error. */
export async function recordOfflineSale(db: Db, actor: { userId: string; organizationId: string }, s: OfflineSaleInput, requestId?: string): Promise<OfflineResult> {
  try {
    return await withTx(db, async (tx) => {
      const dup = await tx.query<{ id: string; receipt_number: string; total_minor: string; offline_variance_minor: string }>(
        'SELECT id, receipt_number, total_minor, offline_variance_minor FROM pos_sales WHERE organization_id = $1 AND client_sale_id = $2',
        [actor.organizationId, s.clientSaleId],
      );
      if (dup.rows[0]) {
        const d = dup.rows[0];
        return { clientSaleId: s.clientSaleId, status: 'duplicate' as const, saleId: d.id, receiptNumber: d.receipt_number, totalMinor: Number(d.total_minor), varianceMinor: Number(d.offline_variance_minor), shortages: 0 };
      }
      const reg = await tx.query<{ id: string; legal_entity_id: string; location_id: string; code: string; status: string; price_list_id: string; max_discount_bps: number; next_receipt_no: string; currency: string; minor_unit: number }>(
        `SELECT r.id, r.legal_entity_id, r.location_id, r.code, r.status, r.price_list_id, r.max_discount_bps, r.next_receipt_no, pl.currency, c.minor_unit
           FROM pos_registers r JOIN price_lists pl ON pl.id = r.price_list_id JOIN currencies c ON c.code = pl.currency
          WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`,
        [s.registerId, actor.organizationId],
      );
      const register = reg.rows[0];
      if (!register) throw new Rejection('Unknown register');
      const target = { kind: 'location', locationId: register.location_id } as const;
      if (!(await can(tx, actor, 'pos.sell', target))) throw new Rejection('You may not sell at this register');
      if (register.status !== 'active') throw new Rejection('The register is inactive');

      const session = await tx.query<{ id: string; cashier_id: string; opened_at: Date; status: string }>('SELECT id, cashier_id, opened_at, status FROM pos_sessions WHERE id = $1 AND register_id = $2', [s.sessionId, register.id]);
      const sess = session.rows[0];
      if (!sess) throw new Rejection('Unknown session');
      if (sess.status !== 'open') throw new Rejection('The session was closed before this sale reached the server');
      if (sess.cashier_id !== actor.userId) throw new Rejection('This session belongs to another cashier');

      // The till's clock decides when the sale happened, within the session and no later than now.
      const now = new Date();
      const claimed = new Date(s.soldAt);
      const soldAt = new Date(Math.min(Math.max(claimed.getTime(), sess.opened_at.getTime()), now.getTime()));

      const withDiscount = s.lines.some((l) => l.discount);
      if (withDiscount && !(await can(tx, actor, 'pos.discount', target))) throw new Rejection('You may not give discounts');
      const mayOverride = await can(tx, actor, 'pos.discount.override', target);

      for (const l of s.lines) {
        const v = await tx.query<{ tracking: string }>('SELECT tracking FROM product_variants WHERE id = $1 AND organization_id = $2', [l.variantId, actor.organizationId]);
        if (!v.rows[0]) throw new Rejection('An item on this sale is not in the catalogue');
        if (v.rows[0].tracking !== 'none') throw new Rejection('Rolls and lots cannot be sold offline');
      }
      let priced;
      try {
        priced = await priceSaleLines(tx, { organizationId: actor.organizationId, priceListId: register.price_list_id, minorUnit: register.minor_unit, maxDiscountBps: register.max_discount_bps, mayOverride, now: soldAt }, s.lines);
      } catch (err) {
        if (err instanceof AppError) throw new Rejection(err.message);
        throw err;
      }
      const totals = saleTotals(priced);
      if (totals.total <= 0n) throw new Rejection('The sale total is not above zero');
      const variance = BigInt(s.tillTotalMinor) - totals.total;

      const receiptNumber = `${register.code}-${register.next_receipt_no.padStart(6, '0')}`;
      await tx.query('UPDATE pos_registers SET next_receipt_no = next_receipt_no + 1 WHERE id = $1', [register.id]);
      const sale = await tx.query<{ id: string }>(
        `INSERT INTO pos_sales (organization_id, legal_entity_id, location_id, register_id, session_id, receipt_number, status, currency, minor_unit, price_list_id,
                                subtotal_minor, discount_minor, tax_minor, total_minor, cashier_id, device_id, client_timestamp, completed_at,
                                offline, client_sale_id, offline_receipt_no, sold_at, offline_variance_minor, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18,$19,$20,$21,now()) RETURNING id`,
        [actor.organizationId, register.legal_entity_id, register.location_id, register.id, sess.id, receiptNumber, register.currency, register.minor_unit, register.price_list_id,
         totals.subtotal, totals.discount, totals.tax, totals.total, actor.userId, s.deviceId ?? null, claimed, soldAt, s.clientSaleId, s.localReceiptNo, soldAt, variance],
      );
      const saleId = sale.rows[0]!.id;
      for (const [i, l] of priced.entries()) {
        await tx.query(
          `INSERT INTO pos_sale_lines (sale_id, line_no, variant_id, lot_id, quantity, unit_price, price_list_item_id, tax_code, tax_rate, tax_inclusive, discount_bps, gross_minor, discount_minor, tax_minor, total_minor)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [saleId, i + 1, l.variantId, l.quantity, l.unitPrice, l.itemId, l.tax?.code ?? null, l.tax?.rate ?? '0', l.tax?.inclusive ?? false, l.p.discountBps, l.p.gross, l.p.discount, l.p.tax, l.p.total],
        );
      }
      // Cash only. If the till took less than the total the drawer will show it at closing; the change figure follows from what was handed over.
      const tendered = BigInt(Math.max(s.tenderedMinor, Number(totals.total)));
      await tx.query(
        `INSERT INTO pos_payments (organization_id, sale_id, method, amount_minor, tendered_minor, change_minor, status, created_by)
         VALUES ($1,$2,'cash',$3,$4,$5,'confirmed',$6)`,
        [actor.organizationId, saleId, totals.total, tendered, tendered - totals.total, actor.userId],
      );

      // The goods have already gone: issue what the books can cover and record the rest, never going below zero.
      const postings: Posting[] = [];
      let shortages = 0;
      for (const l of priced) {
        const have = await tx.query<{ free: string }>(
          `SELECT COALESCE(sum(quantity - reserved), 0) AS free FROM stock_balances WHERE location_id = $1 AND variant_id = $2 AND state = 'on_hand' AND lot_id IS NULL`,
          [register.location_id, l.variantId],
        );
        const free = toScaled(have.rows[0]!.free);
        const want = toScaled(l.quantity);
        const issue = free < want ? free : want;
        if (issue > 0n) postings.push({ locationId: register.location_id, variantId: l.variantId, lotId: null, state: 'on_hand', delta: `-${fromScaled(issue)}`, type: 'issue' });
        if (issue < want) {
          shortages++;
          await tx.query('INSERT INTO pos_offline_exceptions (organization_id, sale_id, location_id, variant_id, quantity_short) VALUES ($1,$2,$3,$4,$5)', [actor.organizationId, saleId, register.location_id, l.variantId, fromScaled(want - issue)]);
        }
      }
      if (postings.length) await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId, reason: 'sale', referenceType: 'pos_sale', referenceId: saleId }, postings);

      await writeAudit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId, action: 'pos.sale', entityType: 'pos_sale', entityId: saleId, after: { receiptNumber, offline: true, totalMinor: Number(totals.total), varianceMinor: Number(variance), shortages } });
      return { clientSaleId: s.clientSaleId, status: 'created' as const, saleId, receiptNumber, totalMinor: Number(totals.total), varianceMinor: Number(variance), shortages };
    });
  } catch (err) {
    if (err instanceof Rejection) return reject(s.clientSaleId, err.message);
    // Two copies of the same sale arrived together: the second finds the first one's result.
    if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'pos_sales_client_sale') {
      const d = await db.query<{ id: string; receipt_number: string; total_minor: string; offline_variance_minor: string }>(
        'SELECT id, receipt_number, total_minor, offline_variance_minor FROM pos_sales WHERE organization_id = $1 AND client_sale_id = $2', [actor.organizationId, s.clientSaleId]);
      if (d.rows[0]) return { clientSaleId: s.clientSaleId, status: 'duplicate', saleId: d.rows[0].id, receiptNumber: d.rows[0].receipt_number, totalMinor: Number(d.rows[0].total_minor), varianceMinor: Number(d.rows[0].offline_variance_minor), shortages: 0 };
    }
    throw err;
  }
}

/** A short fingerprint of a pack's contents, so a till can tell whether it is holding the latest. */
export const packVersion = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

export type { Tx };
