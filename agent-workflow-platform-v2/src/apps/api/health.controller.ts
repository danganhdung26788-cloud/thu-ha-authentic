import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { metricsRegistry } from '../../observability/metrics.js';
import { PlatformService } from './platform.service.js';

@Controller()
export class HealthController {
  constructor(private readonly platform: PlatformService) {}

  @Get('/health')
  health(): Record<string, string> {
    return { status: 'ok' };
  }

  @Get('/ready')
  async ready(): Promise<Record<string, boolean>> {
    const status = await this.platform.readiness();
    if (!status.ready) throw new ServiceUnavailableException(status);
    return status;
  }

  @Get('/metrics')
  @Header('content-type', metricsRegistry.contentType)
  async metrics(): Promise<string> {
    return metricsRegistry.metrics();
  }
}
