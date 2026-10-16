import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { WarehouseTransferService } from './warehouse-transfer.service';

describe('WarehouseTransferService', () => {
  const prisma = {
    location: { findFirst: jest.fn() },
    product: { findMany: jest.fn() },
    warehouseTransfer: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new WarehouseTransferService(prisma as unknown as PrismaService);
  const principal = { issuer: 'https://identity.example', subject: 'user-1', claims: {} };
  const id = '00000000-0000-4000-8000-000000000099';

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      warehouseTransfer: {
        findFirst: prisma.warehouseTransfer.findFirst,
        update: prisma.warehouseTransfer.update,
      },
      auditEvent: { create: jest.fn() },
    }));
  });

  it('rejects a transfer with the same source and destination before touching persistence', async () => {
    await expect(service.createDraft('org-1', principal, {
      sourceLocationId: id, destinationLocationId: id,
      lines: [{ productId: '00000000-0000-4000-8000-000000000001', quantity: '2' }],
      idempotencyKey: 'key-1', reason: 'Replenishment',
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('prevents a requester from rejecting their own pending transfer', async () => {
    prisma.warehouseTransfer.findFirst.mockResolvedValue({
      id, organizationId: 'org-1', status: 'PENDING_APPROVAL',
      requestedBy: 'https://identity.example|user-1',
    });
    await expect(service.reject('org-1', principal, id, 'Rejected')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects receipt quantities that decrease or exceed the dispatched quantity', async () => {
    prisma.warehouseTransfer.findFirst.mockResolvedValue({
      id, organizationId: 'org-1', status: 'IN_TRANSIT',
      destinationLocationId: '00000000-0000-4000-8000-000000000002',
      lines: [{
        id: 'line-1', productId: '00000000-0000-4000-8000-000000000001',
        quantityDispatched: new Prisma.Decimal('10'), quantityReceived: new Prisma.Decimal('5'),
      }],
    });
    await expect(service.receive('org-1', principal, id, {
      lines: [{ productId: '00000000-0000-4000-8000-000000000001', quantityReceived: '4' }],
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.receive('org-1', principal, id, {
      lines: [{ productId: '00000000-0000-4000-8000-000000000001', quantityReceived: '11' }],
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
