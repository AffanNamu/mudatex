import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InventoryMovementType, LocationType, Prisma, ProductStatus, WarehouseTransferStatus, CycleCountStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/authenticated-request';
import { PrismaService } from '../database/prisma.service';
import type { CreateWarehouseTransferDto } from './dto/create-warehouse-transfer.dto';
import type { ReceiveWarehouseTransferDto } from './dto/receive-warehouse-transfer.dto';

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
export class WarehouseTransferService {
  constructor(private readonly prisma: PrismaService) {}

  private actor(principal: AuthenticatedPrincipal): string {
    return [principal.issuer, principal.subject].join('|').slice(0, 160);
  }

  private key(organizationId: string, value: string): string {
    return organizationId + ':' + createHash('sha256').update(value.trim()).digest('hex').slice(0, 48);
  }

  private async audit(tx: Prisma.TransactionClient, organizationId: string, principal: AuthenticatedPrincipal,
    action: string, transferId: string, reason: string, metadata?: Prisma.InputJsonValue) {
    await tx.auditEvent.create({ data: {
      organizationId, actorId: this.actor(principal), action, entityType: 'WarehouseTransfer',
      entityId: transferId, result: 'SUCCESS', reason, metadata,
    } });
  }

  async list(organizationId: string) {
    return this.prisma.warehouseTransfer.findMany({
      where: { organizationId },
      include: {
        sourceLocation: { select: { id: true, code: true, name: true } },
        destinationLocation: { select: { id: true, code: true, name: true } },
        lines: { include: { product: { select: { id: true, sku: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  async createDraft(organizationId: string, principal: AuthenticatedPrincipal, input: CreateWarehouseTransferDto) {
    if (input.sourceLocationId === input.destinationLocationId) {
      throw new UnprocessableEntityException('Source and destination locations must be different');
    }
    for (const line of input.lines) {
      if (!/^\d+(?:\.\d{1,6})?$/.test(line.quantity) || !/[1-9]/.test(line.quantity)) {
        throw new UnprocessableEntityException('Each requested quantity must be greater than zero and use at most 6 decimal places');
      }
    }
    const [source, destination] = await Promise.all([
      this.prisma.location.findFirst({
        where: { id: input.sourceLocationId, active: true, type: { in: [LocationType.WAREHOUSE, LocationType.BRANCH, LocationType.STORE, LocationType.PRODUCTION_SITE] }, legalEntity: { organizationId, active: true } },
        select: { id: true, legalEntityId: true },
      }),
      this.prisma.location.findFirst({
        where: { id: input.destinationLocationId, active: true, type: { in: [LocationType.WAREHOUSE, LocationType.BRANCH, LocationType.STORE, LocationType.PRODUCTION_SITE] }, legalEntity: { organizationId, active: true } },
        select: { id: true, legalEntityId: true },
      }),
    ]);
    if (!source) throw new NotFoundException('Active source stock location was not found in this organization');
    if (!destination) throw new NotFoundException('Active destination stock location was not found in this organization');
    if (source.legalEntityId !== destination.legalEntityId) {
      throw new UnprocessableEntityException('Transfers across legal entities are not supported until intercompany accounting is configured');
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: input.lines.map((line) => line.productId) }, legalEntityId: source.legalEntityId, status: ProductStatus.ACTIVE, legalEntity: { organizationId, active: true } },
      select: { id: true, baseUom: { select: { code: true } } },
    });
    if (products.length !== input.lines.length) {
      throw new UnprocessableEntityException('Every transfer product must be active and belong to the same legal entity as both locations');
    }
    const productMap = new Map(products.map((product) => [product.id, product]));
    const idempotencyKey = this.key(organizationId, 'warehouse-transfer:' + input.idempotencyKey);
    const existing = await this.prisma.warehouseTransfer.findUnique({
      where: { idempotencyKey }, include: { lines: true },
    });
    if (existing) {
      const requested = [...input.lines].sort((a, b) => a.productId.localeCompare(b.productId));
      const stored = [...existing.lines].sort((a, b) => a.productId.localeCompare(b.productId));
      if (existing.sourceLocationId !== source.id || existing.destinationLocationId !== destination.id ||
          existing.reason !== input.reason.trim() || requested.length !== stored.length ||
          requested.some((line, i) => line.productId !== stored[i].productId ||
            new Prisma.Decimal(line.quantity).comparedTo(stored[i].quantityRequested) !== 0)) {
        throw new ConflictException('Idempotency key was already used for a different warehouse transfer');
      }
      return { transfer: existing, replayed: true };
    }

    try {
      const transfer = await this.prisma.$transaction(async (tx) => {
        const created = await tx.warehouseTransfer.create({
          data: {
            organizationId, legalEntityId: source.legalEntityId, sourceLocationId: source.id,
            destinationLocationId: destination.id, requestedBy: this.actor(principal),
            idempotencyKey, reason: input.reason.trim(),
            lines: { create: input.lines.map((line) => ({
              productId: line.productId, quantityRequested: line.quantity,
              uomCode: productMap.get(line.productId)!.baseUom.code,
            })) },
          },
          include: { lines: true },
        });
        await this.audit(tx, organizationId, principal, 'inventory.warehouse_transfer.draft_created',
          created.id, input.reason.trim(), { sourceLocationId: source.id, destinationLocationId: destination.id, lineCount: created.lines.length });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return { transfer, replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.warehouseTransfer.findUnique({ where: { idempotencyKey }, include: { lines: true } });
        if (raced) {
          const requested = [...input.lines].sort((a, b) => a.productId.localeCompare(b.productId));
          const stored = [...raced.lines].sort((a, b) => a.productId.localeCompare(b.productId));
          const sameRequest = raced.sourceLocationId === source.id &&
            raced.destinationLocationId === destination.id &&
            raced.reason === input.reason.trim() &&
            requested.length === stored.length &&
            requested.every((line, index) => line.productId === stored[index].productId &&
              new Prisma.Decimal(line.quantity).comparedTo(stored[index].quantityRequested) === 0);
          if (!sameRequest) {
            throw new ConflictException('Idempotency key was concurrently used for a different warehouse transfer');
          }
          return { transfer: raced, replayed: true };
        }
        throw new ConflictException('A warehouse transfer conflicts with an existing record');
      }
      throw error;
    }
  }

  async submit(organizationId: string, principal: AuthenticatedPrincipal, id: string) {
    return this.transition(organizationId, principal, id, [WarehouseTransferStatus.DRAFT],
      WarehouseTransferStatus.PENDING_APPROVAL, 'inventory.warehouse_transfer.submitted', 'submittedAt');
  }

  async approve(organizationId: string, principal: AuthenticatedPrincipal, id: string) {
    return this.transition(organizationId, principal, id, [WarehouseTransferStatus.PENDING_APPROVAL],
      WarehouseTransferStatus.APPROVED, 'inventory.warehouse_transfer.approved', 'approvedAt', true);
  }

  async reject(organizationId: string, principal: AuthenticatedPrincipal, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "WarehouseTransfer" WHERE "id" = $1::uuid AND "organizationId" = $2::uuid FOR UPDATE', id, organizationId);
      const transfer = await tx.warehouseTransfer.findFirst({ where: { id, organizationId } });
      if (!transfer) throw new NotFoundException('Warehouse transfer was not found in this organization');
      if (transfer.status !== WarehouseTransferStatus.PENDING_APPROVAL) throw new ConflictException('Only a pending transfer can be rejected');
      if (transfer.requestedBy === this.actor(principal)) throw new ConflictException('The requester cannot approve or reject their own transfer');
      const updated = await tx.warehouseTransfer.update({ where: { id }, data: { status: WarehouseTransferStatus.REJECTED, rejectionReason: reason.trim() } });
      await this.audit(tx, organizationId, principal, 'inventory.warehouse_transfer.rejected', id, reason.trim());
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async transition(organizationId: string, principal: AuthenticatedPrincipal, id: string,
    allowed: WarehouseTransferStatus[], next: WarehouseTransferStatus, action: string,
    timestampField?: 'submittedAt' | 'approvedAt', separateApprover = false) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "WarehouseTransfer" WHERE "id" = $1::uuid AND "organizationId" = $2::uuid FOR UPDATE', id, organizationId);
      const transfer = await tx.warehouseTransfer.findFirst({ where: { id, organizationId } });
      if (!transfer) throw new NotFoundException('Warehouse transfer was not found in this organization');
      if (!allowed.includes(transfer.status)) throw new ConflictException('Warehouse transfer is not in a state that permits this action');
      if (separateApprover && transfer.requestedBy === this.actor(principal)) {
        throw new ConflictException('The requester cannot approve their own transfer');
      }
      const updated = await tx.warehouseTransfer.update({
        where: { id },
        data: {
          status: next,
          ...(timestampField ? { [timestampField]: new Date() } : {}),
          ...(next === WarehouseTransferStatus.APPROVED ? { approvedBy: this.actor(principal) } : {}),
        },
      });
      await this.audit(tx, organizationId, principal, action, id, transfer.reason, { from: transfer.status, to: next });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async dispatch(organizationId: string, principal: AuthenticatedPrincipal, id: string) {
    const transfer = await this.prisma.warehouseTransfer.findFirst({
      where: { id, organizationId }, include: { lines: true },
    });
    if (!transfer) throw new NotFoundException('Warehouse transfer was not found in this organization');
    if (transfer.status !== WarehouseTransferStatus.APPROVED) throw new ConflictException('Only an approved transfer can be dispatched');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "WarehouseTransfer" WHERE "id" = $1::uuid AND "organizationId" = $2::uuid FOR UPDATE', id, organizationId);
        const current = await tx.warehouseTransfer.findFirst({ where: { id, organizationId }, include: { lines: true } });
        if (!current) throw new NotFoundException('Warehouse transfer was not found in this organization');
        if (current.status !== WarehouseTransferStatus.APPROVED) throw new ConflictException('Only an approved transfer can be dispatched');
        for (const locationId of [current.sourceLocationId, current.destinationLocationId].sort()) {
          await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', locationId);
        }
        const activeCount = await tx.cycleCountSession.findFirst({
          where: { locationId: { in: [current.sourceLocationId, current.destinationLocationId] }, status: CycleCountStatus.IN_PROGRESS },
          select: { id: true },
        });
        if (activeCount) throw new ConflictException('Transfers cannot be dispatched while a cycle count is active at either location');

        for (const line of current.lines) {
          const movements = await tx.inventoryMovement.findMany({
            where: { legalEntityId: current.legalEntityId, locationId: current.sourceLocationId, productId: line.productId },
            select: { movementType: true, quantity: true },
          });
          const available = movements.reduce((sum, movement) => {
            const quantity = new Prisma.Decimal(movement.quantity);
            if (OUTGOING.has(movement.movementType)) return sum.minus(quantity);
            if (INCOMING.has(movement.movementType)) return sum.plus(quantity);
            if (movement.movementType === InventoryMovementType.ADJUSTMENT) return sum.plus(quantity);
            return sum;
          }, new Prisma.Decimal(0));
          if (available.lessThan(line.quantityRequested)) {
            throw new UnprocessableEntityException('Insufficient stock to dispatch product ' + line.productId);
          }
        }

        for (const line of current.lines) {
          await tx.inventoryMovement.create({
            data: {
              legalEntityId: current.legalEntityId, locationId: current.sourceLocationId,
              productId: line.productId, movementType: InventoryMovementType.TRANSFER_OUT,
              quantity: line.quantityRequested, uomCode: line.uomCode,
              sourceType: 'WAREHOUSE_TRANSFER', sourceId: current.id,
              idempotencyKey: current.idempotencyKey + ':OUT:' + line.productId,
              reason: current.reason,
            },
          });
          await tx.warehouseTransferLine.update({
            where: { id: line.id }, data: { quantityDispatched: line.quantityRequested },
          });
        }
        const updated = await tx.warehouseTransfer.update({
          where: { id }, data: { status: WarehouseTransferStatus.IN_TRANSIT, dispatchedBy: this.actor(principal), dispatchedAt: new Date() },
          include: { lines: true },
        });
        await this.audit(tx, organizationId, principal, 'inventory.warehouse_transfer.dispatched', id, current.reason,
          { lineCount: current.lines.length });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Dispatch conflicts with an existing ledger movement; investigate before retrying');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Concurrent stock activity changed the balance; retry dispatch');
      }
      throw error;
    }
  }

  async receive(organizationId: string, principal: AuthenticatedPrincipal, id: string, input: ReceiveWarehouseTransferDto) {
    const transfer = await this.prisma.warehouseTransfer.findFirst({
      where: { id, organizationId }, include: { lines: true },
    });
    if (!transfer) throw new NotFoundException('Warehouse transfer was not found in this organization');
    if (transfer.status !== WarehouseTransferStatus.IN_TRANSIT && transfer.status !== WarehouseTransferStatus.PARTIALLY_RECEIVED) {
      throw new ConflictException('Only an in-transit transfer can be received');
    }
    const transferLines = new Map(transfer.lines.map((line) => [line.productId, line]));
    for (const inputLine of input.lines) {
      const line = transferLines.get(inputLine.productId);
      if (!line) throw new UnprocessableEntityException('Receipt contains a product that is not part of this transfer');
      const cumulative = new Prisma.Decimal(inputLine.quantityReceived);
      if (cumulative.lessThan(line.quantityReceived) || cumulative.greaterThan(line.quantityDispatched)) {
        throw new UnprocessableEntityException('Cumulative received quantity cannot decrease or exceed the dispatched quantity');
      }
    }
    if (input.complete && transfer.lines.some((line) => !input.lines.some((entry) => entry.productId === line.productId))) {
      throw new UnprocessableEntityException('To close a transfer, provide a final cumulative receipt quantity for every line');
    }
    if (input.complete) {
      for (const inputLine of input.lines) {
        const line = transferLines.get(inputLine.productId)!;
        if (new Prisma.Decimal(inputLine.quantityReceived).lessThan(line.quantityDispatched) && !inputLine.discrepancyReason?.trim()) {
          throw new UnprocessableEntityException('A discrepancy reason is required to close a transfer with a short receipt');
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "WarehouseTransfer" WHERE "id" = $1::uuid AND "organizationId" = $2::uuid FOR UPDATE', id, organizationId);
      const current = await tx.warehouseTransfer.findFirst({ where: { id, organizationId }, include: { lines: true } });
      if (!current) throw new NotFoundException('Warehouse transfer was not found in this organization');
      if (current.status !== WarehouseTransferStatus.IN_TRANSIT && current.status !== WarehouseTransferStatus.PARTIALLY_RECEIVED) {
        throw new ConflictException('Only an in-transit transfer can be received');
      }
      const currentLines = new Map(current.lines.map((line) => [line.productId, line]));
      for (const inputLine of input.lines) {
        const line = currentLines.get(inputLine.productId);
        if (!line) throw new UnprocessableEntityException('Receipt contains a product that is not part of this transfer');
        const cumulative = new Prisma.Decimal(inputLine.quantityReceived);
        if (cumulative.lessThan(line.quantityReceived) || cumulative.greaterThan(line.quantityDispatched)) {
          throw new UnprocessableEntityException('Cumulative received quantity cannot decrease or exceed the dispatched quantity');
        }
      }
      if (input.complete && current.lines.some((line) => !input.lines.some((entry) => entry.productId === line.productId))) {
        throw new UnprocessableEntityException('To close a transfer, provide a final cumulative receipt quantity for every line');
      }
      if (input.complete) {
        for (const inputLine of input.lines) {
          const line = currentLines.get(inputLine.productId)!;
          if (new Prisma.Decimal(inputLine.quantityReceived).lessThan(line.quantityDispatched) && !inputLine.discrepancyReason?.trim()) {
            throw new UnprocessableEntityException('A discrepancy reason is required to close a transfer with a short receipt');
          }
        }
      }
      await tx.$queryRawUnsafe('SELECT "id" FROM "Location" WHERE "id" = $1::uuid FOR UPDATE', current.destinationLocationId);
      const activeCount = await tx.cycleCountSession.findFirst({
        where: { locationId: current.destinationLocationId, status: CycleCountStatus.IN_PROGRESS }, select: { id: true },
      });
      if (activeCount) throw new ConflictException('Receipts cannot be recorded while a cycle count is active at the destination location');

      for (const inputLine of input.lines) {
        const line = currentLines.get(inputLine.productId)!;
        const nextQuantity = new Prisma.Decimal(inputLine.quantityReceived);
        const delta = nextQuantity.minus(line.quantityReceived);
        if (delta.greaterThan(0)) {
          await tx.inventoryMovement.create({
            data: {
              legalEntityId: current.legalEntityId, locationId: current.destinationLocationId,
              productId: line.productId, movementType: InventoryMovementType.TRANSFER_IN,
              quantity: delta, uomCode: line.uomCode, sourceType: 'WAREHOUSE_TRANSFER',
              sourceId: transfer.id,
              idempotencyKey: current.idempotencyKey + ':IN:' + line.productId + ':' + nextQuantity.toFixed(6),
              reason: inputLine.discrepancyReason?.trim() || current.reason,
            },
          });
        }
        await tx.warehouseTransferLine.update({
          where: { id: line.id },
          data: {
            quantityReceived: nextQuantity,
            ...(inputLine.discrepancyReason?.trim() ? { discrepancyReason: inputLine.discrepancyReason.trim() } : {}),
          },
        });
      }
      const updatedLines = await tx.warehouseTransferLine.findMany({ where: { transferId: id } });
      const allExactlyReceived = updatedLines.every((line) => new Prisma.Decimal(line.quantityReceived).equals(line.quantityDispatched));
      const complete = input.complete || allExactlyReceived;
      const status = complete ? WarehouseTransferStatus.RECEIVED : WarehouseTransferStatus.PARTIALLY_RECEIVED;
      const updated = await tx.warehouseTransfer.update({
        where: { id },
        data: {
          status, lastReceivedBy: this.actor(principal),
          ...(complete ? { receivedAt: new Date() } : {}),
        },
        include: { lines: true },
      });
      const discrepancies = updatedLines.filter((line) => new Prisma.Decimal(line.quantityReceived).lessThan(line.quantityDispatched))
        .map((line) => ({ productId: line.productId, dispatched: line.quantityDispatched.toString(), received: line.quantityReceived.toString(), reason: line.discrepancyReason }));
      await this.audit(tx, organizationId, principal, 'inventory.warehouse_transfer.received', id,
        discrepancies.length ? 'Receipt recorded with discrepancies' : current.reason,
        { complete, discrepancies, linesReceived: input.lines.length });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
