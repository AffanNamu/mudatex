import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live(): { status: 'ok'; service: string } {
    return { status: 'ok', service: 'mudatex-platform-api' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: { api: 'ok'; database: 'ok' } }> {
    const connected = await this.prisma.checkConnection();
    if (!connected) {
      throw new ServiceUnavailableException({ status: 'not_ready', checks: { api: 'ok', database: 'unavailable' } });
    }
    return { status: 'ok', checks: { api: 'ok', database: 'ok' } };
  }
}
