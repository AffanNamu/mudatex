import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ProductsService } from './products.service';
import type { CreateProductDto } from './dto/create-product.dto';

describe('ProductsService', () => {
  const prisma = {
    legalEntity: { findFirst: jest.fn() },
    unitOfMeasure: { findFirst: jest.fn() },
    product: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new ProductsService(prisma as unknown as PrismaService);
  const principal = { issuer: 'https://identity.example', subject: 'user-123', claims: {} };
  const input: CreateProductDto = {
    legalEntityId: '00000000-0000-4000-8000-000000000001',
    sku: '  wax-001 ',
    name: '  Wax Print  ',
    baseUomId: '00000000-0000-4000-8000-000000000002',
    rollTracked: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.legalEntity.findFirst.mockResolvedValue({ id: input.legalEntityId });
    prisma.unitOfMeasure.findFirst.mockResolvedValue({ id: input.baseUomId });
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        product: { create: jest.fn().mockResolvedValue({ id: 'product-1', sku: 'WAX-001', status: 'DRAFT' }) },
        auditEvent: { create: jest.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('requires the legal entity to be active and inside the selected organization', async () => {
    prisma.legalEntity.findFirst.mockResolvedValue(null);
    await expect(service.create('org-1', principal, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.legalEntity.findFirst).toHaveBeenCalledWith({
      where: { id: input.legalEntityId, organizationId: 'org-1', active: true },
      select: { id: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires an active unit of measure', async () => {
    prisma.unitOfMeasure.findFirst.mockResolvedValue(null);
    await expect(service.create('org-1', principal, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('normalizes the SKU and creates a draft product with an audit event in one transaction', async () => {
    const productCreate = jest.fn().mockResolvedValue({ id: 'product-1', sku: 'WAX-001', status: 'DRAFT' });
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({ product: { create: productCreate }, auditEvent: { create: auditCreate } }),
    );

    await service.create('org-1', principal, input);

    expect(productCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ legalEntityId: input.legalEntityId, sku: 'WAX-001', name: 'Wax Print', status: 'DRAFT' }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-1', action: 'product.created', entityId: 'product-1' }),
    }));
  });

  it('activates a draft product with an audit event transactionally', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'product-1', status: 'DRAFT' });
    const productUpdate = jest.fn().mockResolvedValue({ id: 'product-1', status: 'ACTIVE' });
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({ product: { update: productUpdate }, auditEvent: { create: auditCreate } }),
    );

    await expect(service.activate('org-1', principal, 'product-1'))
      .resolves.toEqual({ id: 'product-1', status: 'ACTIVE', replayed: false });
    expect(productUpdate).toHaveBeenCalledWith({ where: { id: 'product-1' }, data: { status: 'ACTIVE' } });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'product.activated', entityId: 'product-1' }),
    }));
  });

  it('does not activate products outside the selected organization', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.activate('org-1', principal, 'product-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects archived products', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'product-1', status: 'ARCHIVED' });
    await expect(service.activate('org-1', principal, 'product-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
