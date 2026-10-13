import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsEnricher } from './reservations-enricher.service';

@Module({
  imports: [SecurityModule],
  controllers: [ReservationsController],
  providers: [ReservationsEnricher],
  exports: [ReservationsEnricher],
})
export class ReservationsModule {}
