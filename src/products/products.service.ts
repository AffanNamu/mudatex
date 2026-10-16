import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedPrincipal } from '../auth/authenticated-request';
import type { CreateProductDto } from './dto/create-product.dto';
import type { ListProductsQueryDto } from './dto/list-products-query.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      legalEntity: { organizationId, active: true },
      ...(query.status ? { status: query.status } : {}),
    };
    const skip = (query.page - 1) * query.limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take: query.limit,
        include: {
          baseUom: { select: { id: true, code: true, name: true, decimalPlaces: true } },
          legalEntity: { select: { id: true, code: true, name: true, countryCode: true, functionalCurrency: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }

  async create(organizationId: string, principal: AuthenticatedPrincipal, input: CreateProductDto) {
    const sku = input.sku.trim().toUpperCase();
    const name = input.name.trim();
    if (!sku || !name) {
      throw new ConflictException('SKU and product name cannot be blank');
    }

    const [legalEntity, uom] = await Promise.all([
      this.prisma.legalEntity.findFirst({
        where: { id: input.legalEntityId, organizationId, active: true },
        select: { id: true },
      }),
      this.prisma.unitOfMeasure.findFirst({
        where: { id: input.baseUomId, active: true },
        select: { id: true },
      }),
    ]);

    if (!legalEntity) throw new NotFoundException('Active legal entity was not found in this organization');
    if (!uom) throw new NotFoundException('Active unit of measure was not found');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            legalEntityId: legalEntity.id,
            sku,
            name,
            description: input.description?.trim() || null,
            categoryCode: input.categoryCode?.trim() || null,
            fabricFamily: input.fabricFamily?.trim() || null,
            pattern: input.pattern?.trim() || null,
            colour: input.colour?.trim() || null,
            widthMm: input.widthMm,
            composition: input.composition?.trim() || null,
            baseUomId: uom.id,
            lotTracked: input.lotTracked ?? false,
            rollTracked: input.rollTracked ?? false,
            status: ProductStatus.DRAFT,
          },
          include: {
            baseUom: { select: { id: true, code: true, name: true, decimalPlaces: true } },
            legalEntity: { select: { id: true, code: true, name: true, countryCode: true, functionalCurrency: true } },
          },
        });

        await tx.auditEvent.create({
          data: {
            organizationId,
            actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'product.created',
            entityType: 'Product',
            entityId: product.id,
            result: 'SUCCESS',
            metadata: { sku, status: product.status },
          },
        });
        return product;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A product with this SKU already exists for the legal entity');
      }
      throw error;
    }
  }

  async activate(organizationId: string, principal: AuthenticatedPrincipal, productId: string) {
    const existing = await this.prisma.product.findFirst({
      where: { id: productId, legalEntity: { organizationId, active: true } },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Product was not found in this organization');
    if (existing.status === ProductStatus.ACTIVE) return { id: existing.id, status: existing.status, replayed: true };
    if (existing.status === ProductStatus.ARCHIVED) {
      throw new ConflictException('Archived products cannot be activated');
    }

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id: productId },
        data: { status: ProductStatus.ACTIVE },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
          action: 'product.activated',
          entityType: 'Product',
          entityId: product.id,
          result: 'SUCCESS',
          metadata: { previousStatus: existing.status, status: product.status },
        },
      });
      return { id: product.id, status: product.status, replayed: false };
    });
  }
}
