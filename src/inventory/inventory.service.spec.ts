import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { InventoryService } from './inventory.service';
import type { ReceiveStockDto } from './dto/receive-stock.dto';

describe('InventoryService', () => {
  const prisma = {
    product: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    inventoryMovement: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new InventoryService(prisma as unknown as PrismaService);
  const principal = { issuer: 'https://identity.example', subject: 'user-123', claims: {} };
  const input: ReceiveStockDto = {
    productId: '00000000-0000-4000-8000-000000000001',
    locationId: '00000000-0000-4000-8000-000000000002',
    quantity: '12.500',
    idempotencyKey: 'receipt-001',
    reason: 'Supplier delivery',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.product.findFirst.mockResolvedValue({
      id: input.productId,
      legalEntityId: 'legal-1',
      baseUom: { code: 'METER' },
    });
    prisma.location.findFirst.mockResolvedValue({ id: input.locationId, legalEntityId: 'legal-1' });
    prisma.inventoryMovement.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        inventoryMovement: { create: jest.fn().mockResolvedValue({ id: 'movement-1', ...input, uomCode: 'METER' }) },
        auditEvent: { create: jest.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('requires an active product in the selected organization', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.receive('org-1', principal, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires the product and stock location to belong to the same legal entity', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: input.locationId, legalEntityId: 'other-legal' });
    await expect(service.receive('org-1', principal, input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates an append-only receipt movement and audit event in one transaction', async () => {
    const movementCreate = jest.fn().mockResolvedValue({ id: 'movement-1' });
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({ inventoryMovement: { create: movementCreate }, auditEvent: { create: auditCreate } }),
    );

    const result = await service.receive('org-1', principal, input);
    expect(result).toEqual({ movement: { id: 'movement-1' }, replayed: false });
    expect(movementCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        movementType: 'RECEIPT',
        quantity: '12.500',
        uomCode: 'METER',
        idempotencyKey: 'org-1:receipt-001',
      }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'inventory.receipt.created', organizationId: 'org-1' }),
    }));
  });

  it('rejects non-positive quantities before writing', async () => {
    await expect(service.receive('org-1', principal, { ...input, quantity: '0.000' }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replays a matching idempotency key without writing a second movement', async () => {
    prisma.inventoryMovement.findUnique.mockResolvedValue({
      id: 'movement-1', productId: input.productId, locationId: input.locationId,
      quantity: '12.500', uomCode: 'METER', reason: 'Supplier delivery',
    });
    const result = await service.receive('org-1', principal, input);
    expect(result.replayed).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different payload', async () => {
    prisma.inventoryMovement.findUnique.mockResolvedValue({
      id: 'movement-1', productId: input.productId, locationId: input.locationId,
      quantity: '9.000', uomCode: 'METER', reason: 'Supplier delivery',
    });
    await expect(service.receive('org-1', principal, input)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
