import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok'; service: string } {
    return { status: 'ok', service: 'mudatex-platform-api' };
  }

  @Get('ready')
  ready(): { status: 'ok'; checks: { api: 'ok'; database: 'not-configured' } } {
    // Database readiness becomes a real connectivity check when Prisma is wired.
    // Do not report database health as verified before that check exists.
    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('Database configuration is missing');
    }
    return { status: 'ok', checks: { api: 'ok', database: 'not-configured' } };
  }
}
