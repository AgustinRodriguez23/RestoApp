import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { OwnerModule } from './owner/owner.module';
import { OverviewModule } from './overview/overview.module';
import { ReservationsModule } from './reservations/reservations.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { UpstreamModule } from './upstream/upstream.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    UpstreamModule,
    AuthModule,
    RestaurantsModule,
    ReservationsModule,
    OverviewModule,
    OwnerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
