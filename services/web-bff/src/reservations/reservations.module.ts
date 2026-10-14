import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { ReservationPaymentsController } from './reservation-payments.controller';
import { ReservationsController } from './reservations.controller';
import { PaymentsEnricher, ReservationsEnricher } from './reservations-enricher.service';

@Module({
  imports: [SecurityModule],
  controllers: [ReservationsController, ReservationPaymentsController],
  providers: [ReservationsEnricher, PaymentsEnricher],
  exports: [ReservationsEnricher, PaymentsEnricher],
})
export class ReservationsModule {}
