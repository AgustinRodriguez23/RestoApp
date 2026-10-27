import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { requireSecret } from '../common/secrets';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * El BFF solo verifica que el token sea auténtico y no esté vencido (así rechaza rápido lo inválido
 * sin molestar a los servicios). Los permisos por rol y por recurso los decide cada servicio.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: requireSecret(config, 'JWT_SECRET') }),
    }),
  ],
  providers: [JwtAuthGuard],
  exports: [JwtModule, JwtAuthGuard],
})
export class SecurityModule {}
