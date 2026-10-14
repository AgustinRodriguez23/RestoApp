import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { setCurrentUserId } from '../observability/request-context';
import { JwtPayload } from './jwt-payload';

export type AuthenticatedRequest = Request & { user: JwtPayload };

/** Valida el JWT localmente (sin llamar a auth-service): solo necesita el secreto compartido. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Falta el token de autenticación');
    }

    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(token);
      setCurrentUserId(request.user.sub);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    return true;
  }
}
