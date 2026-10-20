import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { RabbitConnection } from '../messaging/rabbit-connection';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly rabbit: RabbitConnection,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio, de su base de datos y de la mensajería' })
  async check() {
    try {
      if (!this.connection.db) throw new Error('sin conexión');
      await this.connection.db.admin().ping();
    } catch {
      throw new ServiceUnavailableException('La base de datos no responde');
    }
    // RabbitMQ caído no tira el servicio abajo: la bandeja se sigue pudiendo leer, solo no llegan avisos nuevos
    const messaging = !this.rabbit.enabled ? 'disabled' : this.rabbit.isUp ? 'up' : 'down';
    return { status: 'ok', service: 'notifications-service', database: 'up', messaging };
  }
}
