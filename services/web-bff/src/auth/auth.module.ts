import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { AuthController } from './auth.controller';

@Module({ imports: [SecurityModule], controllers: [AuthController] })
export class AuthModule {}
