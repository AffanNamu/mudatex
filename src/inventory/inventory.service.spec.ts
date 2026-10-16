import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { InventoryService } from './inventory.service';
import type { ReceiveStockDto } from './dto/receive-stock.dto';
import type { TransferStockDto } from './dto/transfer-stock.dto';
import type { CreateCycleCountDto } from './dto/create-cycle-count.dto';

describe('InventoryService', () => {
  const prisma = {
    product: { findFirst: jest.fn(), findMany: jest.fn() },
    location: { findFirst: jest.fn() },
    inventoryMovement: { findUnique: jest.fn(), findMany: jest.fn() },
    cycleCountSession: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new InventoryService(prisma as unknown as PrismaService);
  const principal = { issuer: 'https://identity.example', subject: 'user-123', claims: {} };
  const receipt: ReceiveStockDto = {
    productId: '00000000-0000-4000-8000-000000000001',
    locationId: '00000000-0000-4000-8000-000000000002',
    quantity: '12.500', idempotencyKey: 'receipt-001', reason: 'Supplier delivery',
  };
  const transfer: TransferStockDto = {
    productId: receipt.productId, sourceLocationId: receipt.locationId,
    destinationLocationId: '00000000-0000-4000-8000-000000000003',
    quantity: '3.000', idempotencyKey: 'transfer-001', reason: 'Branch replenishment',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.cycleCountSession.findUnique.mockResolvedValue(null);
    prisma.cycleCountSession.findFirst.mockResolvedValue(null);
    prisma.cycleCountSession.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ id: receipt.productId, baseUom: { code: 'METER' } }]);
    prisma.product.findFirst.mockResolvedValue({ id: receipt.productId, legalEntityId: 'legal-1', baseUom: { code: 'METER' } });
    prisma.location.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, legalEntityId: 'legal-1' }));
    prisma.inventoryMovement.findUnique.mockResolvedValue(null);
    prisma.inventoryMovement.findMany.mockResolvedValue([{ movementType: 'RECEIPT', quantity: new Prisma.Decimal('12.500') }]);
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      inventoryMovement: {
        create: jest.fn().mockResolvedValue({ id: 'movement-1' }),
        findMany: prisma.inventoryMovement.findMany,
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      cycleCountSession: { findFirst: jest.fn().mockResolvedValue(null) },
      stockReservation: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    }));
  });

  it('rejects missing products and cross-legal-entity receipts', async () => {
    prisma.product.findFirst.mockResolvedValueOnce(null);
    await expect(service.receive('org-1', principal, receipt)).rejects.toBeInstanceOf(NotFoundException);
    prisma.product.findFirst.mockResolvedValue({ id: receipt.productId, legalEntityId: 'legal-1', baseUom: { code: 'METER' } });
    prisma.location.findFirst.mockResolvedValueOnce({ id: receipt.locationId, legalEntityId: 'other-entity' });
    await expect(service.receive('org-1', principal, receipt)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('writes a receipt and audit event transactionally', async () => {
    const createMovement = jest.fn().mockResolvedValue({ id: 'receipt-movement' });
    const createAudit = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      inventoryMovement: { create: createMovement }, auditEvent: { create: createAudit },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      cycleCountSession: { findFirst: jest.fn().mockResolvedValue(null) },
      stockReservation: { findMany: jest.fn().mockResolvedValue([]) },
    }));
    await service.receive('org-1', principal, receipt);
    expect(createMovement).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ movementType: 'RECEIPT', quantity: '12.500', uomCode: 'METER' }),
    }));
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'inventory.receipt.created' }) }));
  });

  it('rejects zero quantity and replays the same receipt idempotently', async () => {
    await expect(service.receive('org-1', principal, { ...receipt, quantity: '0.000' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    prisma.inventoryMovement.findUnique.mockResolvedValueOnce({
      id: 'receipt-movement', productId: receipt.productId, locationId: receipt.locationId,
      quantity: new Prisma.Decimal('12.500'), uomCode: 'METER', reason: receipt.reason,
    });
    await expect(service.receive('org-1', principal, receipt)).resolves.toMatchObject({ replayed: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a paired transfer atomically after checking source stock', async () => {
    const out = jest.fn().mockResolvedValue({ id: 'out-1' });
    const into = jest.fn().mockResolvedValue({ id: 'in-1' });
    const audit = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue([{ movementType: 'RECEIPT', quantity: new Prisma.Decimal('12.500') }]),
        create: jest.fn().mockImplementation(({ data }) => data.movementType === 'TRANSFER_OUT' ? out() : into()),
      },
      cycleCountSession: { findFirst: jest.fn().mockResolvedValue(null) },
      stockReservation: { findMany: jest.fn().mockResolvedValue([]) },
      auditEvent: { create: audit },
    }));
    const result = await service.transfer('org-1', principal, transfer);
    expect(result.replayed).toBe(false);
    expect(out).toHaveBeenCalled();
    expect(into).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'inventory.transfer.created' }) }));
  });


  it('creates a cycle count with expected quantities snapshotted from the ledger', async () => {
    const input: CreateCycleCountDto = {
      locationId: receipt.locationId, productIds: [receipt.productId], idempotencyKey: 'count-001',
    };
    prisma.inventoryMovement.findMany.mockResolvedValue([
      { productId: receipt.productId, movementType: 'RECEIPT', quantity: new Prisma.Decimal('12.500') },
      { productId: receipt.productId, movementType: 'SALE', quantity: new Prisma.Decimal('2.000') },
    ]);
    const createSession = jest.fn().mockResolvedValue({
      id: 'count-session-1', status: 'IN_PROGRESS',
      lines: [{ productId: receipt.productId, expectedQuantity: new Prisma.Decimal('10.500') }],
    });
    const audit = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      inventoryMovement: { findMany: prisma.inventoryMovement.findMany },
      cycleCountSession: { findFirst: jest.fn().mockResolvedValue(null), create: createSession },
      stockAdjustmentRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      auditEvent: { create: audit },
    }));
    const result = await service.createCycleCount('org-1', principal, input);
    expect(result.replayed).toBe(false);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: { create: [{ productId: receipt.productId, expectedQuantity: new Prisma.Decimal('10.500') }] },
      }),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'inventory.cycle_count.created' }),
    }));
  });

  it('submits a completed cycle count as pending adjustment requests, not direct ledger changes', async () => {
    const session = {
      id: 'count-session-1', organizationId: 'org-1', legalEntityId: 'legal-1',
      locationId: receipt.locationId, status: 'IN_PROGRESS',
      lines: [{
        id: 'line-1', productId: receipt.productId,
        expectedQuantity: new Prisma.Decimal('10.000'), countedQuantity: new Prisma.Decimal('8.000'),
        product: { id: receipt.productId, baseUom: { code: 'METER' } },
      }],
    };
    prisma.cycleCountSession.findFirst.mockResolvedValue(session);
    const createAdjustment = jest.fn().mockResolvedValue({ id: 'adjustment-1' });
    const updateSession = jest.fn().mockResolvedValue({ count: 1 });
    const audit = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      cycleCountSession: { findFirst: jest.fn().mockResolvedValue(session), updateMany: updateSession },
      stockAdjustmentRequest: { create: createAdjustment },
      auditEvent: { create: audit },
    }));
    const result = await service.submitCycleCount('org-1', principal, session.id);
    expect(result.status).toBe('SUBMITTED');
    expect(result.adjustmentRequests).toHaveLength(1);
    expect(createAdjustment).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ quantityDelta: new Prisma.Decimal('-2.000'), uomCode: 'METER' }),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'inventory.cycle_count.submitted' }),
    }));
  });

  it('rejects transfers when stock is insufficient or the legal entity differs', async () => {
    prisma.inventoryMovement.findMany.mockResolvedValue([{ movementType: 'RECEIPT', quantity: new Prisma.Decimal('1.000') }]);
    await expect(service.transfer('org-1', principal, transfer)).rejects.toBeInstanceOf(UnprocessableEntityException);
    prisma.inventoryMovement.findMany.mockResolvedValue([{ movementType: 'RECEIPT', quantity: new Prisma.Decimal('12.500') }]);
    prisma.location.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id, legalEntityId: where.id === transfer.destinationLocationId ? 'legal-2' : 'legal-1',
    }));
    await expect(service.transfer('org-1', principal, transfer)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
