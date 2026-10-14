import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { RabbitConnection } from '../messaging/rabbit-connection';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbit: RabbitConnection,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Estado del servicio',
    description:
      'Responde 503 si la base no responde. RabbitMQ caído NO tumba el servicio (los eventos esperan en el outbox), ' +
      'pero se informa en `messaging`.',
  })
  async check() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('La base de datos no responde');
    }
    const messaging = !this.rabbit.enabled ? 'disabled' : this.rabbit.isUp ? 'up' : 'down';
    return { status: 'ok', service: 'reservations-service', database: 'up', messaging };
  }
}
