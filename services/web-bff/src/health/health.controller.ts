import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { settle } from '../common/settle';
import { UpstreamClient, UpstreamName } from '../upstream/upstream-client';

const UPSTREAMS: UpstreamName[] = ['auth', 'restaurants', 'reservations', 'payments'];

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get()
  @ApiOperation({
    summary: 'Estado del BFF y de los servicios que usa',
    description: 'Siempre responde 200 mientras el BFF esté vivo; `status` es "degraded" si algún servicio no responde.',
  })
  async check() {
    const results = await Promise.all(UPSTREAMS.map((name) => settle(this.upstream.call(name, { path: '/health' }))));
    const upstreams = Object.fromEntries(UPSTREAMS.map((name, i) => [name, results[i].ok ? 'up' : 'down']));
    const allUp = results.every((r) => r.ok);
    return { status: allUp ? 'ok' : 'degraded', service: 'web-bff', upstreams };
  }
}
