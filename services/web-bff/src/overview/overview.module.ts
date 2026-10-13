import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { SecurityModule } from '../security/security.module';
import { MeController } from './me.controller';
import { MeOverviewService } from './me-overview.service';

@Module({
  imports: [SecurityModule, ReservationsModule],
  controllers: [MeController],
  providers: [MeOverviewService],
})
export class OverviewModule {}
