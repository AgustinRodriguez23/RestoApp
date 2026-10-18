import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { OwnerController } from './owner.controller';
import { OwnerMenuController } from './owner-menu.controller';

@Module({ imports: [SecurityModule], controllers: [OwnerController, OwnerMenuController] })
export class OwnerModule {}
