import { Module } from '@nestjs/common';
import { RestaurantsController } from './restaurants.controller';
import { RestaurantsOverviewService } from './restaurants-overview.service';

@Module({ controllers: [RestaurantsController], providers: [RestaurantsOverviewService] })
export class RestaurantsModule {}
