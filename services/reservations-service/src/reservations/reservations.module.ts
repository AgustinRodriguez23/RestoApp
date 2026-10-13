import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RestaurantsClientModule } from '../restaurants-client/restaurants-client.module';
import { SecurityModule } from '../security/security.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { BookingPolicy } from './booking-policy';
import { Reservation } from './entities/reservation.entity';
import { ReservationsController } from './reservations.controller';
import { ReservationsSchemaBootstrap } from './reservations-schema.bootstrap';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [SecurityModule, RestaurantsClientModule, TypeOrmModule.forFeature([Reservation])],
  controllers: [ReservationsController, AvailabilityController],
  providers: [ReservationsService, AvailabilityService, BookingPolicy, ReservationsSchemaBootstrap],
})
export class ReservationsModule {}
