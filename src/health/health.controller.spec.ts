import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from '../database/prisma.service';

describe('HealthController', () => {
  const prisma = { checkConnection: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  async function controller(): Promise<HealthController> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    return module.get(HealthController);
  }

  it('reports liveness', async () => {
    expect((await controller()).live()).toEqual({ status: 'ok', service: 'mudatex-platform-api' });
  });

  it('reports readiness only when PostgreSQL responds', async () => {
    prisma.checkConnection.mockResolvedValue(true);
    await expect((await controller()).ready()).resolves.toEqual({ status: 'ok', checks: { api: 'ok', database: 'ok' } });
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    prisma.checkConnection.mockResolvedValue(false);
    await expect((await controller()).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
