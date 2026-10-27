import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { AuthThrottlerGuard, REGISTER_LIMIT, THROTTLE_ACCOUNT, THROTTLE_IP, WINDOW_MS } from './auth-throttling';
import { LoginDto, RegisterDto } from './dto/auth.dto';

/** Puerta de entrada de autenticación: el frontend nunca habla directo con auth-service. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post('register')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ [THROTTLE_IP]: { limit: REGISTER_LIMIT, ttl: WINDOW_MS } })
  @SkipThrottle({ [THROTTLE_ACCOUNT]: true })
  @ApiOperation({ summary: 'Registrar un usuario (reenvía a auth-service)' })
  @ApiTooManyRequestsResponse({ description: `Más de ${REGISTER_LIMIT} altas desde la misma IP en 15 minutos` })
  register(@Body() dto: RegisterDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: '/auth/register', body: dto }, ctx);
  }

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión y obtener un JWT (reenvía a auth-service)' })
  @ApiTooManyRequestsResponse({ description: 'Más de 10 intentos con el mismo email, o de 50 en total, desde la misma IP en 15 minutos' })
  login(@Body() dto: LoginDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: '/auth/login', body: dto }, ctx);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Datos del usuario autenticado' })
  @ApiOkResponse({ description: '{ id, email, name, role }' })
  me(@Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { path: '/auth/me' }, ctx);
  }
}
