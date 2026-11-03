import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OwnerRequest } from './owner-request.entity';
import { OwnerRequestsController } from './owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';

@Module({
  imports: [TypeOrmModule.forFeature([OwnerRequest]), UsersModule, AuthModule],
  controllers: [OwnerRequestsController],
  providers: [OwnerRequestsService],
})
export class OwnerRequestsModule {}
