import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { OwnerController } from './owner.controller';

@Module({ imports: [SecurityModule], controllers: [OwnerController] })
export class OwnerModule {}
