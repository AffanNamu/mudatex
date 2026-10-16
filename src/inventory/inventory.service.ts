import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InventoryMovementType, LocationType, Prisma, ProductStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/authenticated-request';
import { PrismaService } from '../database/prisma.service';
import type { ReceiveStockDto } from './dto/receive-stock.dto';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async receive(organizationId: string, principal: AuthenticatedPrincipal, input: ReceiveStockDto) {
    const quantity = input.quantity.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(quantity) || !/[1-9]/.test(quantity)) {
      throw new UnprocessableEntityException('Quantity must be greater than zero and use at most 6 decimal places');
    }

    const [product, location] = await Promise.all([
      this.prisma.product.findFirst({
        where: {
          id: input.productId,
          status: ProductStatus.ACTIVE,
          legalEntity: { organizationId, active: true },
        },
        select: { id: true, legalEntityId: true, baseUom: { select: { code: true } } },
      }),
      this.prisma.location.findFirst({
        where: {
          id: input.locationId,
          active: true,
          type: { in: [LocationType.WAREHOUSE, LocationType.BRANCH, LocationType.STORE, LocationType.PRODUCTION_SITE] },
          legalEntity: { organizationId, active: true },
        },
        select: { id: true, legalEntityId: true },
      }),
    ]);

    if (!product) throw new NotFoundException('Active product was not found in this organization');
    if (!location) throw new NotFoundException('Active stock location was not found in this organization');
    if (location.legalEntityId !== product.legalEntityId) {
      throw new UnprocessableEntityException('Product and stock location must belong to the same legal entity');
    }

    const uomCode = product.baseUom.code;
    const scopedKey = organizationId + ':' + input.idempotencyKey.trim();
    const existing = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: scopedKey } });
    if (existing) return this.resolveReplay(existing, product.id, location.id, quantity, uomCode, input.reason);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const movement = await tx.inventoryMovement.create({
          data: {
            legalEntityId: product.legalEntityId,
            locationId: location.id,
            productId: product.id,
            movementType: InventoryMovementType.RECEIPT,
            quantity,
            uomCode,
            sourceType: 'MANUAL_RECEIPT',
            sourceId: input.idempotencyKey.trim(),
            idempotencyKey: scopedKey,
            reason: input.reason.trim(),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId,
            actorId: [principal.issuer, principal.subject].join('|').slice(0, 160),
            action: 'inventory.receipt.created',
            entityType: 'InventoryMovement',
            entityId: movement.id,
            result: 'SUCCESS',
            reason: input.reason.trim(),
            metadata: {
              productId: product.id,
              locationId: location.id,
              quantity,
              uomCode,
              idempotencyKey: input.idempotencyKey.trim(),
            },
          },
        });
        return { movement, replayed: false };
      });
    } catch (error) {
      // A concurrent request may win the unique-key race. Only replay if the payload matches.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: scopedKey } });
        if (raced) return this.resolveReplay(raced, product.id, location.id, quantity, uomCode, input.reason);
        throw new ConflictException('An inventory movement conflicts with an existing record');
      }
      throw error;
    }
  }

  private resolveReplay(
    existing: { id: string; productId: string; locationId: string; quantity: Prisma.Decimal; uomCode: string; reason: string | null },
    productId: string,
    locationId: string,
    quantity: string,
    uomCode: string,
    reason: string,
  ) {
    const sameQuantity = new Prisma.Decimal(existing.quantity).equals(new Prisma.Decimal(quantity));
    if (
      existing.productId !== productId ||
      existing.locationId !== locationId ||
      !sameQuantity ||
      existing.uomCode !== uomCode ||
      existing.reason !== reason.trim()
    ) {
      throw new ConflictException('Idempotency key was already used for a different receipt payload');
    }
    return { movement: existing, replayed: true };
  }
}
