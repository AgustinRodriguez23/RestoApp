import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { LoginDto, RegisterDto } from './dto/auth.dto';

/** Puerta de entrada de autenticación: el frontend nunca habla directo con auth-service. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post('register')
  @ApiOperation({ summary: 'Registrar un usuario (reenvía a auth-service)' })
  register(@Body() dto: RegisterDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: '/auth/register', body: dto }, ctx);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión y obtener un JWT (reenvía a auth-service)' })
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
