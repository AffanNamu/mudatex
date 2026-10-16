import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InventoryMovementType, LocationType, Prisma, ProductStatus, StockAdjustmentStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/authenticated-request';
import { PrismaService } from '../database/prisma.service';
import type { ReceiveStockDto } from './dto/receive-stock.dto';
import type { TransferStockDto } from './dto/transfer-stock.dto';
import type { ListStockBalancesQueryDto } from './dto/list-stock-balances-query.dto';
import type { RequestStockAdjustmentDto } from './dto/request-stock-adjustment.dto';

const OUTGOING = new Set<InventoryMovementType>([
  InventoryMovementType.SALE, InventoryMovementType.TRANSFER_OUT,
  InventoryMovementType.PRODUCTION_ISSUE, InventoryMovementType.SCRAP,
]);
const INCOMING = new Set<InventoryMovementType>([
  InventoryMovementType.OPENING_BALANCE, InventoryMovementType.RECEIPT,
  InventoryMovementType.RETURN, InventoryMovementType.TRANSFER_IN,
  InventoryMovementType.PRODUCTION_OUTPUT,
]);

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  private scopedIdempotencyKey(organizationId: string, key: string, suffix = ''): string {
    const digest = createHash('sha256').update(key.trim()).digest('hex');
    return organizationId + ':' + digest.slice(0, 48) + suffix;
  }

  private validatePositiveQuantity(quantity: string) {
    if (!/^\d+(?:\.\d{1,6})?$/.test(quantity) || !/[1-9]/.test(quantity)) {
      throw new UnprocessableEntityException('Quantity must be greater than zero and use at most 6 decimal places');
    }
  }

  private async findStockLocation(organizationId: string, locationId: string) {
    return this.prisma.location.findFirst({
      where: {
        id: locationId, active: true,
        type: { in: [LocationType.WAREHOUSE, LocationType.BRANCH, LocationType.STORE, LocationType.PRODUCTION_SITE] },
        legalEntity: { organizationId, active: true },
      },
      select: { id: true, legalEntityId: true },
    });
  }

  async receive(organizationId: string, principal: AuthenticatedPrincipal, input: ReceiveStockDto) {
    const quantity = input.quantity.trim();
    this.validatePositiveQuantity(quantity);
    const [product, location] = await Promise.all([
      this.prisma.product.findFirst({
        where: { id: input.productId, status: ProductStatus.ACTIVE, legalEntity: { organizationId, active: true } },
        select: { id: true, legalEntityId: true, baseUom: { select: { code: true } } },
      }),
      this.findStockLocation(organizationId, input.locationId),
    ]);
    if (!product) throw new NotFoundException('Active product was not found in this organization');
    if (!location) throw new NotFoundException('Active stock location was not found in this organization');
    if (location.legalEntityId !== product.legalEntityId) {
      throw new UnprocessableEntityException('Product and stock location must belong to the same legal entity');
    }

    const uomCode = product.baseUom.code;
    const idempotencyKey = this.scopedIdempotencyKey(organizationId, input.idempotencyKey);
    const existing = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey } });
    if (existing) return this.resolveReceiptReplay(existing, product.id, location.id, quantity, uomCode, input.reason);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const movement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: product.legalEntityId, locationId: location.id, productId: product.id,
            movementType: InventoryMovementType.RECEIPT, quantity, uomCode,
            sourceType: 'MANUAL_RECEIPT', sourceId: input.idempotencyKey.trim(), idempotencyKey,
            reason: input.reason.trim(),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId, actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'inventory.receipt.created', entityType: 'InventoryMovement', entityId: movement.id,
            result: 'SUCCESS', reason: input.reason.trim(),
            metadata: { productId: product.id, locationId: location.id, quantity, uomCode, idempotencyKey },
          },
        });
        return { movement, replayed: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey } });
        if (raced) return this.resolveReceiptReplay(raced, product.id, location.id, quantity, uomCode, input.reason);
        throw new ConflictException('An inventory movement conflicts with an existing record');
      }
      throw error;
    }
  }

  async transfer(organizationId: string, principal: AuthenticatedPrincipal, input: TransferStockDto) {
    const quantity = input.quantity.trim();
    this.validatePositiveQuantity(quantity);
    if (input.sourceLocationId === input.destinationLocationId) {
      throw new UnprocessableEntityException('Source and destination locations must be different');
    }

    const [product, source, destination] = await Promise.all([
      this.prisma.product.findFirst({
        where: { id: input.productId, status: ProductStatus.ACTIVE, legalEntity: { organizationId, active: true } },
        select: { id: true, legalEntityId: true, baseUom: { select: { code: true } } },
      }),
      this.findStockLocation(organizationId, input.sourceLocationId),
      this.findStockLocation(organizationId, input.destinationLocationId),
    ]);
    if (!product) throw new NotFoundException('Active product was not found in this organization');
    if (!source) throw new NotFoundException('Active source stock location was not found in this organization');
    if (!destination) throw new NotFoundException('Active destination stock location was not found in this organization');
    if (source.legalEntityId !== product.legalEntityId || destination.legalEntityId !== product.legalEntityId) {
      throw new UnprocessableEntityException('Product and both transfer locations must belong to the same legal entity');
    }

    const uomCode = product.baseUom.code;
    const rootKey = this.scopedIdempotencyKey(organizationId, input.idempotencyKey);
    const outKey = rootKey + ':OUT';
    const inKey = rootKey + ':IN';
    const [existingOut, existingIn] = await Promise.all([
      this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: outKey } }),
      this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: inKey } }),
    ]);
    if (existingOut || existingIn) {
      if (!existingOut || !existingIn) throw new ConflictException('Transfer idempotency record is incomplete; investigate the inventory ledger');
      return this.resolveTransferReplay(existingOut, existingIn, product.id, source.id, destination.id, quantity, uomCode, input.reason);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock source location while checking stock; serializable isolation rejects conflicting concurrent transfers.
        await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', source.id);
        const movements = await tx.inventoryMovement.findMany({
          where: { legalEntityId: product.legalEntityId, locationId: source.id, productId: product.id },
          select: { movementType: true, quantity: true },
        });
        const available = movements.reduce((sum, movement) => {
          const amount = new Prisma.Decimal(movement.quantity);
          if (OUTGOING.has(movement.movementType)) return sum.minus(amount);
          if (INCOMING.has(movement.movementType)) return sum.plus(amount);
          if (movement.movementType === InventoryMovementType.ADJUSTMENT) return sum.plus(amount);
          return sum;
        }, new Prisma.Decimal(0));
        if (available.lessThan(new Prisma.Decimal(quantity))) {
          throw new UnprocessableEntityException('Insufficient available stock for this transfer');
        }

        const sourceMovement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: product.legalEntityId, locationId: source.id, productId: product.id,
            movementType: InventoryMovementType.TRANSFER_OUT, quantity, uomCode,
            sourceType: 'INTERNAL_TRANSFER', sourceId: rootKey, idempotencyKey: outKey, reason: input.reason.trim(),
          },
        });
        const destinationMovement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: product.legalEntityId, locationId: destination.id, productId: product.id,
            movementType: InventoryMovementType.TRANSFER_IN, quantity, uomCode,
            sourceType: 'INTERNAL_TRANSFER', sourceId: rootKey, idempotencyKey: inKey, reason: input.reason.trim(),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId, actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'inventory.transfer.created', entityType: 'InventoryTransfer', entityId: rootKey,
            result: 'SUCCESS', reason: input.reason.trim(),
            metadata: {
              productId: product.id, sourceLocationId: source.id, destinationLocationId: destination.id,
              quantity, uomCode, sourceMovementId: sourceMovement.id, destinationMovementId: destinationMovement.id,
              idempotencyKey: rootKey,
            },
          },
        });
        return { transferId: rootKey, sourceMovement, destinationMovement, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const [racedOut, racedIn] = await Promise.all([
          this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: outKey } }),
          this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: inKey } }),
        ]);
        if (racedOut && racedIn) return this.resolveTransferReplay(racedOut, racedIn, product.id, source.id, destination.id, quantity, uomCode, input.reason);
        throw new ConflictException('An inventory transfer conflicts with an existing record');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Concurrent stock activity changed the balance; retry with the same idempotency key');
      }
      throw error;
    }
  }


  async requestStockAdjustment(organizationId: string, principal: AuthenticatedPrincipal, input: RequestStockAdjustmentDto) {
    const quantityDelta = input.quantityDelta.trim();
    if (!/^-?\\d+(?:\\.\\d{1,6})?$/.test(quantityDelta) || new Prisma.Decimal(quantityDelta).isZero()) {
      throw new UnprocessableEntityException('Adjustment delta must be non-zero and use at most 6 decimal places');
    }
    const [product, location] = await Promise.all([
      this.prisma.product.findFirst({
        where: { id: input.productId, status: ProductStatus.ACTIVE, legalEntity: { organizationId, active: true } },
        select: { id: true, legalEntityId: true, baseUom: { select: { code: true } } },
      }),
      this.findStockLocation(organizationId, input.locationId),
    ]);
    if (!product) throw new NotFoundException('Active product was not found in this organization');
    if (!location) throw new NotFoundException('Active stock location was not found in this organization');
    if (location.legalEntityId !== product.legalEntityId) {
      throw new UnprocessableEntityException('Product and stock location must belong to the same legal entity');
    }

    const idempotencyKey = this.scopedIdempotencyKey(organizationId, 'stock-adjustment:' + input.idempotencyKey);
    const existing = await this.prisma.stockAdjustmentRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.productId !== product.id || existing.locationId !== location.id ||
          !new Prisma.Decimal(existing.quantityDelta).equals(new Prisma.Decimal(quantityDelta)) ||
          existing.reason !== input.reason.trim()) {
        throw new ConflictException('Idempotency key was already used for a different stock adjustment');
      }
      return { request: existing, replayed: true };
    }

    try {
      const request = await this.prisma.$transaction(async (tx) => {
        const created = await tx.stockAdjustmentRequest.create({
          data: {
            organizationId, legalEntityId: product.legalEntityId, locationId: location.id, productId: product.id,
            requestedBy: [principal.issuer, principal.subject].join('|').slice(0, 160),
            quantityDelta, uomCode: product.baseUom.code, reason: input.reason.trim(), idempotencyKey,
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId, actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'inventory.adjustment.requested', entityType: 'StockAdjustmentRequest', entityId: created.id,
            result: 'PENDING', reason: input.reason.trim(),
            metadata: { productId: product.id, locationId: location.id, quantityDelta, uomCode: product.baseUom.code },
          },
        });
        return created;
      });
      return { request, replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.stockAdjustmentRequest.findUnique({ where: { idempotencyKey } });
        if (raced && raced.productId === product.id && raced.locationId === location.id &&
            new Prisma.Decimal(raced.quantityDelta).equals(new Prisma.Decimal(quantityDelta)) &&
            raced.reason === input.reason.trim()) return { request: raced, replayed: true };
        throw new ConflictException('A stock adjustment request conflicts with an existing record');
      }
      throw error;
    }
  }

  async listStockAdjustments(organizationId: string) {
    return this.prisma.stockAdjustmentRequest.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async approveStockAdjustment(organizationId: string, principal: AuthenticatedPrincipal, requestId: string) {
    const request = await this.prisma.stockAdjustmentRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!request) throw new NotFoundException('Stock adjustment request was not found in this organization');
    if (request.status !== StockAdjustmentStatus.PENDING) {
      throw new ConflictException('Only pending stock adjustment requests can be approved');
    }
    const delta = new Prisma.Decimal(request.quantityDelta);
    const movementKey = this.scopedIdempotencyKey(organizationId, 'approved-stock-adjustment:' + request.id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', request.locationId);
        const movements = await tx.inventoryMovement.findMany({
          where: { legalEntityId: request.legalEntityId, locationId: request.locationId, productId: request.productId },
          select: { movementType: true, quantity: true },
        });
        const available = movements.reduce((sum, movement) => {
          const amount = new Prisma.Decimal(movement.quantity);
          if (OUTGOING.has(movement.movementType)) return sum.minus(amount);
          if (INCOMING.has(movement.movementType)) return sum.plus(amount);
          if (movement.movementType === InventoryMovementType.ADJUSTMENT) return sum.plus(amount);
          return sum;
        }, new Prisma.Decimal(0));
        if (available.plus(delta).lessThan(0)) {
          throw new UnprocessableEntityException('This adjustment would make available stock negative');
        }
        const changed = await tx.stockAdjustmentRequest.updateMany({
          where: { id: request.id, organizationId, status: StockAdjustmentStatus.PENDING },
          data: {
            status: StockAdjustmentStatus.APPROVED,
            reviewedBy: [principal.issuer, principal.subject].join('|').slice(0, 160),
            reviewedAt: new Date(),
          },
        });
        if (changed.count !== 1) throw new ConflictException('The stock adjustment was reviewed by another user');
        const movement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: request.legalEntityId, locationId: request.locationId, productId: request.productId,
            movementType: InventoryMovementType.ADJUSTMENT, quantity: delta, uomCode: request.uomCode,
            sourceType: 'STOCK_ADJUSTMENT', sourceId: request.id, idempotencyKey: movementKey, reason: request.reason,
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId, actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'inventory.adjustment.approved', entityType: 'StockAdjustmentRequest', entityId: request.id,
            result: 'SUCCESS', reason: request.reason,
            metadata: { quantityDelta: delta.toFixed(6), movementId: movement.id, locationId: request.locationId, productId: request.productId },
          },
        });
        return { requestId: request.id, status: StockAdjustmentStatus.APPROVED, movement };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Concurrent stock activity changed the balance; retry the approval');
      }
      throw error;
    }
  }

  async rejectStockAdjustment(organizationId: string, principal: AuthenticatedPrincipal, requestId: string, reason: string) {
    const request = await this.prisma.stockAdjustmentRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!request) throw new NotFoundException('Stock adjustment request was not found in this organization');
    if (request.status !== StockAdjustmentStatus.PENDING) {
      throw new ConflictException('Only pending stock adjustment requests can be rejected');
    }
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.stockAdjustmentRequest.updateMany({
        where: { id: request.id, organizationId, status: StockAdjustmentStatus.PENDING },
        data: {
          status: StockAdjustmentStatus.REJECTED,
          reviewedBy: [principal.issuer, principal.subject].join('|').slice(0, 160),
          reviewedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new ConflictException('The stock adjustment was reviewed by another user');
      await tx.auditEvent.create({
        data: {
          organizationId, actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
          action: 'inventory.adjustment.rejected', entityType: 'StockAdjustmentRequest', entityId: request.id,
          result: 'SUCCESS', reason: reason.trim(),
          metadata: { requestReason: request.reason, quantityDelta: new Prisma.Decimal(request.quantityDelta).toFixed(6) },
        },
      });
      return { requestId: request.id, status: StockAdjustmentStatus.REJECTED };
    });
  }

  async listBalances(organizationId: string, query: ListStockBalancesQueryDto) {
    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        product: { legalEntity: { organizationId, active: true } },
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
      },
      select: {
        legalEntityId: true, locationId: true, productId: true, uomCode: true, movementType: true, quantity: true,
        location: { select: { code: true, name: true } }, product: { select: { sku: true, name: true } },
      },
      orderBy: [{ locationId: 'asc' }, { productId: 'asc' }, { occurredAt: 'asc' }],
    });
    const balances = new Map<string, {
      legalEntityId: string; locationId: string; locationCode: string; locationName: string;
      productId: string; sku: string; productName: string; uomCode: string; quantity: Prisma.Decimal;
    }>();
    for (const movement of movements) {
      const key = movement.locationId + ':' + movement.productId;
      const current = balances.get(key) ?? {
        legalEntityId: movement.legalEntityId, locationId: movement.locationId,
        locationCode: movement.location.code, locationName: movement.location.name,
        productId: movement.productId, sku: movement.product.sku, productName: movement.product.name,
        uomCode: movement.uomCode, quantity: new Prisma.Decimal(0),
      };
      const amount = new Prisma.Decimal(movement.quantity);
      if (OUTGOING.has(movement.movementType)) current.quantity = current.quantity.minus(amount);
      else if (INCOMING.has(movement.movementType)) current.quantity = current.quantity.plus(amount);
      else if (movement.movementType === InventoryMovementType.ADJUSTMENT) current.quantity = current.quantity.plus(amount);
      balances.set(key, current);
    }
    return Array.from(balances.values()).filter((b) => !b.quantity.isZero())
      .map((b) => ({ ...b, quantity: b.quantity.toFixed(6) }));
  }

  private resolveReceiptReplay(
    existing: { id: string; productId: string; locationId: string; quantity: Prisma.Decimal; uomCode: string; reason: string | null },
    productId: string, locationId: string, quantity: string, uomCode: string, reason: string,
  ) {
    if (existing.productId !== productId || existing.locationId !== locationId ||
        !new Prisma.Decimal(existing.quantity).equals(new Prisma.Decimal(quantity)) ||
        existing.uomCode !== uomCode || existing.reason !== reason.trim()) {
      throw new ConflictException('Idempotency key was already used for a different receipt payload');
    }
    return { movement: existing, replayed: true };
  }

  private resolveTransferReplay(
    outgoing: { id: string; productId: string; locationId: string; quantity: Prisma.Decimal; uomCode: string; reason: string | null; movementType: InventoryMovementType },
    incoming: { id: string; productId: string; locationId: string; quantity: Prisma.Decimal; uomCode: string; reason: string | null; movementType: InventoryMovementType },
    productId: string, sourceId: string, destinationId: string, quantity: string, uomCode: string, reason: string,
  ) {
    const same = (movement: typeof outgoing, locationId: string, type: InventoryMovementType) =>
      movement.productId === productId && movement.locationId === locationId && movement.movementType === type &&
      new Prisma.Decimal(movement.quantity).equals(new Prisma.Decimal(quantity)) &&
      movement.uomCode === uomCode && movement.reason === reason.trim();
    if (!same(outgoing, sourceId, InventoryMovementType.TRANSFER_OUT) ||
        !same(incoming, destinationId, InventoryMovementType.TRANSFER_IN)) {
      throw new ConflictException('Idempotency key was already used for a different transfer payload');
    }
    return { transferId: outgoing.id, sourceMovement: outgoing, destinationMovement: incoming, replayed: true };
  }
}
