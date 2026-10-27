import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { SecurityModule } from '../security/security.module';
import { authThrottlerOptions } from './auth-throttling';
import { AuthController } from './auth.controller';

@Module({ imports: [SecurityModule, ThrottlerModule.forRoot(authThrottlerOptions)], controllers: [AuthController] })
export class AuthModule {}
