import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { SecurityModule } from '../security/security.module';
import { authThrottlerOptions } from './auth-throttling';
import { AuthController } from './auth.controller';
import { DemoAccounts } from './demo-accounts';
import { DemoController } from './demo.controller';

@Module({
  imports: [SecurityModule, ThrottlerModule.forRoot(authThrottlerOptions)],
  controllers: [AuthController, DemoController],
  providers: [DemoAccounts],
})
export class AuthModule {}
