import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsIn } from 'class-validator';
import { Ctx } from '../security/call-context.decorator';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { AuthThrottlerGuard, DEMO_LIMIT, THROTTLE_ACCOUNT, THROTTLE_IP, WINDOW_MS } from './auth-throttling';
import { DEMO_ROLES, DemoAccounts, DemoRole } from './demo-accounts';

export class DemoLoginDto {
  @ApiProperty({ enum: DEMO_ROLES, example: 'owner' })
  @IsIn(DEMO_ROLES)
  role: DemoRole;
}

/**
 * Entrar a la app sin registrarse, con una cuenta compartida de demo (para quien quiere probarla, como un recruiter).
 * La contraseña nunca sale del servidor: el front pide el rol y el BFF hace el login con las credenciales del entorno.
 */
@ApiTags('auth')
@Controller('auth/demo')
export class DemoController {
  private readonly logger = new Logger(DemoController.name);

  constructor(
    private readonly upstream: UpstreamClient,
    private readonly demo: DemoAccounts,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Qué cuentas de demo hay (el login muestra un botón por cada una)' })
  @ApiOkResponse({ description: "{ accounts: ['owner', 'customer'] }: vacío si el servidor no tiene ninguna configurada" })
  list() {
    return { accounts: this.demo.available() };
  }

  @Post()
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ [THROTTLE_IP]: { limit: DEMO_LIMIT, ttl: WINDOW_MS } })
  @SkipThrottle({ [THROTTLE_ACCOUNT]: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entrar con la cuenta de demo de ese rol: devuelve lo mismo que el login' })
  @ApiOkResponse({ description: '{ accessToken, user }' })
  @ApiTooManyRequestsResponse({ description: `Más de ${DEMO_LIMIT} entradas de demo desde la misma IP en 15 minutos` })
  async login(@Body() dto: DemoLoginDto, @Ctx() ctx: CallContext) {
    const credentials = this.demo.credentials(dto.role);
    if (!credentials) throw new NotFoundException('Esa cuenta de demo no está disponible');

    try {
      // Sin el token del visitante (si ya tenía sesión): este login no tiene nada que ver con él
      return await this.upstream.call('auth', { method: 'POST', path: '/auth/login', body: credentials }, { correlationId: ctx.correlationId });
    } catch (error) {
      // Un 401 acá quiere decir que la contraseña del entorno no coincide con la de la cuenta (o que la cuenta no existe):
      // es un error de configuración nuestro, no del visitante. Se registra y se responde "no disponible".
      if (error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED) {
        this.logger.error(`la cuenta de demo "${dto.role}" no pudo entrar: revisar DEMO_* en el .env`);
        throw new ServiceUnavailableException('La cuenta de demo no está disponible en este momento');
      }
      throw error;
    }
  }
}
