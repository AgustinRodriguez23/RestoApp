import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [SecurityModule],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
