import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CycleCountStatus, InventoryMovementType, LocationType, Prisma, ProductStatus, StockReservationStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/authenticated-request';
import { PrismaService } from '../database/prisma.service';
import type { CreateStockReservationDto } from './dto/create-stock-reservation.dto';
import type { FulfillStockReservationDto } from './dto/fulfill-stock-reservation.dto';

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
export class StockReservationService {
  constructor(private readonly prisma: PrismaService) {}

  private actor(principal: AuthenticatedPrincipal) {
    return [principal.issuer, principal.subject].join('|').slice(0, 160);
  }

  private key(organizationId: string, key: string, suffix = '') {
    return organizationId + ':' + createHash('sha256').update(key.trim()).digest('hex').slice(0, 48) + suffix;
  }

  private quantity(value: string) {
    const normalized = value.trim();
    if (!/^[0-9]+(?:[.][0-9]{1,6})?$/.test(normalized) || !/[1-9]/.test(normalized)) {
      throw new UnprocessableEntityException('Quantity must be greater than zero and use at most 6 decimal places');
    }
    return new Prisma.Decimal(normalized);
  }

  private async onHand(tx: Prisma.TransactionClient, locationId: string, productId: string) {
    const movements = await tx.inventoryMovement.findMany({
      where: { locationId, productId },
      select: { movementType: true, quantity: true },
    });
    return movements.reduce((total, movement) => {
      if (OUTGOING.has(movement.movementType)) return total.minus(movement.quantity);
      if (INCOMING.has(movement.movementType)) return total.plus(movement.quantity);
      if (movement.movementType === InventoryMovementType.ADJUSTMENT) return total.plus(movement.quantity);
      return total;
    }, new Prisma.Decimal(0));
  }

  private async activeReserved(tx: Prisma.TransactionClient, locationId: string, productId: string, now = new Date()) {
    const reservations = await tx.stockReservation.findMany({
      where: {
        locationId,
        status: { in: [StockReservationStatus.ACTIVE, StockReservationStatus.PARTIALLY_FULFILLED] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: { lines: { where: { productId }, select: { quantityReserved: true, quantityFulfilled: true } } },
    });
    return reservations.reduce((total, reservation) => total.plus(reservation.lines.reduce(
      (sum, line) => sum.plus(line.quantityReserved.minus(line.quantityFulfilled)), new Prisma.Decimal(0),
    )), new Prisma.Decimal(0));
  }

  async create(organizationId: string, principal: AuthenticatedPrincipal, input: CreateStockReservationDto) {
    const orderReference = input.orderReference.trim();
    const lines = input.lines.map(line => ({ productId: line.productId, quantity: this.quantity(line.quantity) }));
    if (new Set(lines.map(line => line.productId)).size !== lines.length) {
      throw new UnprocessableEntityException('A product may appear only once in a reservation');
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException('expiresAt must be in the future');
    }
    const idempotencyKey = this.key(organizationId, input.idempotencyKey);
    const location = await this.prisma.location.findFirst({
      where: {
        id: input.locationId, active: true,
        type: { in: [LocationType.WAREHOUSE, LocationType.BRANCH, LocationType.STORE] },
        legalEntity: { organizationId, active: true },
      },
      select: { id: true, legalEntityId: true },
    });
    if (!location) throw new NotFoundException('Active stock location was not found in this organization');

    const existing = await this.prisma.stockReservation.findUnique({
      where: { idempotencyKey }, include: { lines: true },
    });
    if (existing) return this.resolveCreateReplay(existing, location.id, orderReference, expiresAt, lines);

    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', location.id);
        const products = await tx.product.findMany({
          where: { id: { in: lines.map(line => line.productId) }, status: ProductStatus.ACTIVE, legalEntityId: location.legalEntityId },
          select: { id: true, baseUom: { select: { code: true } } },
        });
        if (products.length !== lines.length) {
          throw new UnprocessableEntityException('Every reserved product must be active and belong to the selected location legal entity');
        }
        const productById = new Map(products.map(product => [product.id, product]));
        for (const line of lines) {
          const onHand = await this.onHand(tx, location.id, line.productId);
          const reserved = await this.activeReserved(tx, location.id, line.productId);
          if (onHand.minus(reserved).lessThan(line.quantity)) {
            throw new ConflictException('Insufficient available-to-promise stock for product ' + line.productId);
          }
        }
        const reservation = await tx.stockReservation.create({
          data: {
            organizationId, legalEntityId: location.legalEntityId, locationId: location.id,
            orderReference, status: StockReservationStatus.ACTIVE, createdBy: this.actor(principal),
            idempotencyKey, expiresAt,
            lines: { create: lines.map(line => ({
              productId: line.productId, quantityReserved: line.quantity,
              uomCode: productById.get(line.productId)!.baseUom.code,
            })) },
          },
          include: { lines: true },
        });
        await tx.auditEvent.create({
          data: {
            organizationId, actorId: this.actor(principal), action: 'inventory.reservation.created',
            entityType: 'StockReservation', entityId: reservation.id, result: 'SUCCESS',
            reason: 'Stock reserved for order ' + orderReference,
            metadata: { locationId: location.id, orderReference, expiresAt: expiresAt?.toISOString() ?? null, lineCount: lines.length },
          },
        });
        return { reservation, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.stockReservation.findUnique({ where: { idempotencyKey }, include: { lines: true } });
        if (raced) return this.resolveCreateReplay(raced, location.id, orderReference, expiresAt, lines);
        throw new ConflictException('A stock reservation conflicts with an existing record');
      }
      throw error;
    }
  }

  private resolveCreateReplay(existing: any, locationId: string, orderReference: string, expiresAt: Date | null, lines: {productId: string; quantity: Prisma.Decimal}[]) {
    const oldLines = [...existing.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const newLines = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const same = existing.locationId === locationId && existing.orderReference === orderReference
      && (existing.expiresAt?.toISOString() ?? null) === (expiresAt?.toISOString() ?? null)
      && oldLines.length === newLines.length
      && oldLines.every((line, i) => line.productId === newLines[i].productId && new Prisma.Decimal(line.quantityReserved).equals(newLines[i].quantity));
    if (!same) throw new ConflictException('Idempotency key was already used for a different reservation payload');
    return { reservation: existing, replayed: true };
  }

  async list(organizationId: string) {
    return this.prisma.stockReservation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { location: { select: { id: true, code: true, name: true } }, lines: { include: { product: { select: { id: true, sku: true, name: true } } } } },
    });
  }

  async release(organizationId: string, principal: AuthenticatedPrincipal, id: string, reason: string) {
    return this.prisma.$transaction(async tx => {
      const reservation = await tx.stockReservation.findFirst({ where: { id, organizationId }, select: { id: true, locationId: true, status: true } });
      if (!reservation) throw new NotFoundException('Stock reservation was not found');
      await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', reservation.locationId);
      const current = await tx.stockReservation.findFirst({ where: { id, organizationId }, include: { lines: true } });
      if (!current) throw new NotFoundException('Stock reservation was not found');
      if (current.status === StockReservationStatus.RELEASED || current.status === StockReservationStatus.EXPIRED) {
        return { reservation: current, replayed: true };
      }
      if (current.status === StockReservationStatus.FULFILLED) throw new ConflictException('A fulfilled reservation cannot be released');
      const updated = await tx.stockReservation.update({
        where: { id }, data: { status: StockReservationStatus.RELEASED, releasedBy: this.actor(principal), releasedAt: new Date() },
        include: { lines: true },
      });
      await tx.auditEvent.create({
        data: { organizationId, actorId: this.actor(principal), action: 'inventory.reservation.released', entityType: 'StockReservation', entityId: id, result: 'SUCCESS', reason: reason.trim() },
      });
      return { reservation: updated, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async fulfill(organizationId: string, principal: AuthenticatedPrincipal, id: string, input: FulfillStockReservationDto) {
    const requested = input.lines.map(line => ({ productId: line.productId, quantity: this.quantity(line.quantity) }));
    if (new Set(requested.map(line => line.productId)).size !== requested.length) {
      throw new UnprocessableEntityException('A product may appear only once in a fulfillment request');
    }
    const reservation = await this.prisma.stockReservation.findFirst({
      where: { id, organizationId }, include: { lines: true },
    });
    if (!reservation) throw new NotFoundException('Stock reservation was not found');
    const rootKey = this.key(organizationId, input.idempotencyKey, ':FULFIL');
    const movementKeys = requested.map(line => this.key(organizationId, input.idempotencyKey, ':F:' + line.productId));
    const existingMovements = await this.prisma.inventoryMovement.findMany({ where: { idempotencyKey: { in: movementKeys } } });
    if (existingMovements.length) {
      const replayIsComplete = existingMovements.length === requested.length && requested.every(line => {
        const movement = existingMovements.find(m => m.idempotencyKey === this.key(organizationId, input.idempotencyKey, ':F:' + line.productId));
        return movement && movement.sourceType === 'STOCK_RESERVATION_FULFILMENT' && movement.sourceId === id && new Prisma.Decimal(movement.quantity).equals(line.quantity);
      });
      if (!replayIsComplete) throw new ConflictException('Fulfillment idempotency key was reused with a different or incomplete payload');
      return { movements: existingMovements, status: reservation.status, replayed: true };
    }

    return this.prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', reservation.locationId);
      const racedMovements = await tx.inventoryMovement.findMany({ where: { idempotencyKey: { in: movementKeys } } });
      if (racedMovements.length) {
        const replayIsComplete = racedMovements.length === requested.length && requested.every(line => {
          const movement = racedMovements.find(m => m.idempotencyKey === this.key(organizationId, input.idempotencyKey, ':F:' + line.productId));
          return movement && movement.sourceType === 'STOCK_RESERVATION_FULFILMENT' && movement.sourceId === id && new Prisma.Decimal(movement.quantity).equals(line.quantity);
        });
        if (!replayIsComplete) throw new ConflictException('Fulfillment idempotency key was reused with a different or incomplete payload');
        return { movements: racedMovements, status: reservation.status, replayed: true };
      }
      const activeCount = await tx.cycleCountSession.findFirst({ where: { locationId: reservation.locationId, status: CycleCountStatus.IN_PROGRESS }, select: { id: true } });
      if (activeCount) throw new ConflictException('Fulfillment is paused while a cycle count is in progress at this location');
      const current = await tx.stockReservation.findFirst({ where: { id, organizationId }, include: { lines: true } });
      if (!current) throw new NotFoundException('Stock reservation was not found');
      if (current.status !== StockReservationStatus.ACTIVE && current.status !== StockReservationStatus.PARTIALLY_FULFILLED) {
        throw new ConflictException('Only active reservations can be fulfilled');
      }
      if (current.expiresAt && current.expiresAt <= new Date()) throw new ConflictException('Reservation has expired');
      const movements = [];
      for (const line of requested) {
        const reservationLine = current.lines.find(item => item.productId === line.productId);
        if (!reservationLine) throw new UnprocessableEntityException('Product is not part of this reservation: ' + line.productId);
        const remaining = reservationLine.quantityReserved.minus(reservationLine.quantityFulfilled);
        if (line.quantity.greaterThan(remaining)) throw new UnprocessableEntityException('Fulfillment exceeds the remaining reserved quantity for product ' + line.productId);
        const onHand = await this.onHand(tx, current.locationId, line.productId);
        const totalReserved = await this.activeReserved(tx, current.locationId, line.productId);
        if (onHand.lessThan(totalReserved)) throw new ConflictException('Physical stock has fallen below total active reservations for product ' + line.productId);
        const movement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: current.legalEntityId, locationId: current.locationId, productId: line.productId,
            movementType: InventoryMovementType.SALE, quantity: line.quantity,
            uomCode: reservationLine.uomCode, sourceType: 'STOCK_RESERVATION_FULFILMENT', sourceId: id,
            idempotencyKey: this.key(organizationId, input.idempotencyKey, ':F:' + line.productId),
            reason: 'Fulfilled order ' + current.orderReference,
          },
        });
        await tx.stockReservationLine.update({ where: { id: reservationLine.id }, data: { quantityFulfilled: { increment: line.quantity } } });
        movements.push(movement);
      }
      const refreshedLines = await tx.stockReservationLine.findMany({ where: { reservationId: id } });
      const complete = refreshedLines.every(line => line.quantityFulfilled.greaterThanOrEqualTo(line.quantityReserved));
      const status = complete ? StockReservationStatus.FULFILLED : StockReservationStatus.PARTIALLY_FULFILLED;
      await tx.stockReservation.update({ where: { id }, data: { status } });
      await tx.auditEvent.create({
        data: { organizationId, actorId: this.actor(principal), action: 'inventory.reservation.fulfilled', entityType: 'StockReservation', entityId: id, result: 'SUCCESS', reason: 'Order fulfillment posted to inventory ledger', metadata: { movementIds: movements.map(m => m.id), idempotencyKey: rootKey, status } },
      });
      return { movements, status, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
