import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagingModule } from '../messaging/messaging.module';
import { SecurityModule } from '../security/security.module';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationSchema } from './schemas/notification.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }]), SecurityModule, MessagingModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEventsConsumer],
  exports: [NotificationsService],
})
export class NotificationsModule {}
