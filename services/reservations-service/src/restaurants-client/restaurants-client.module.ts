import { Module } from '@nestjs/common';
import { RestaurantsClient } from './restaurants-client.service';

@Module({
  providers: [RestaurantsClient],
  exports: [RestaurantsClient],
})
export class RestaurantsClientModule {}
