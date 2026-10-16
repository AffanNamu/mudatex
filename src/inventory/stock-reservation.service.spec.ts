import { ConflictException } from '@nestjs/common';
import { InventoryMovementType, Prisma, ProductStatus, StockReservationStatus } from '@prisma/client';
import { StockReservationService } from './stock-reservation.service';

describe('StockReservationService', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const locationId = '22222222-2222-4222-8222-222222222222';
  const productId = '33333333-3333-4333-8333-333333333333';
  const principal = { issuer: 'https://identity.example.test', subject: 'user-123', claims: {} } as any;

  function setup(onHand: string, reserved: string) {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      product: {
        findMany: jest.fn().mockResolvedValue([{ id: productId, baseUom: { code: 'EA' } }]),
      },
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue(onHand === '0' ? [] : [{
          movementType: InventoryMovementType.RECEIPT,
          quantity: new Prisma.Decimal(onHand),
        }]),
        create: jest.fn(),
      },
      stockReservation: {
        findMany: jest.fn().mockResolvedValue(reserved === '0' ? [] : [{
          lines: [{ quantityReserved: new Prisma.Decimal(reserved), quantityFulfilled: new Prisma.Decimal(0) }],
        }]),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: '44444444-4444-4444-8444-444444444444',
          ...data,
          lines: data.lines.create,
        })),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
    };
    const prisma: any = {
      location: { findFirst: jest.fn().mockResolvedValue({ id: locationId, legalEntityId: '55555555-5555-4555-8555-555555555555' }) },
      stockReservation: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (callback: any) => callback(tx)),
    };
    return { service: new StockReservationService(prisma), prisma, tx };
  }

  it('rejects a reservation when available-to-promise stock is insufficient', async () => {
    const { service, tx } = setup('5', '4');
    await expect(service.create(organizationId, principal, {
      locationId,
      orderReference: 'ORDER-100',
      idempotencyKey: 'reserve-100',
      lines: [{ productId, quantity: '2' }],
    })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.stockReservation.create).not.toHaveBeenCalled();
  });

  it('creates a reservation without adding an inventory movement', async () => {
    const { service, tx } = setup('5', '0');
    const result = await service.create(organizationId, principal, {
      locationId,
      orderReference: 'ORDER-101',
      idempotencyKey: 'reserve-101',
      lines: [{ productId, quantity: '2.5' }],
    });
    expect(result.replayed).toBe(false);
    expect(tx.stockReservation.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
  });
});
