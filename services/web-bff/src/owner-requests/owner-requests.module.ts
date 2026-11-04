import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { OwnerRequestsController } from './owner-requests.controller';

@Module({ imports: [SecurityModule], controllers: [OwnerRequestsController] })
export class OwnerRequestsModule {}
