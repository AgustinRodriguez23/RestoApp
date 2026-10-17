import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MenuItem, MenuItemSchema } from '../menu/schemas/menu-item.schema';
import { CacheModule } from '../cache/cache.module';
import { SecurityModule } from '../security/security.module';
import { RestaurantsController } from './restaurants.controller';
import { RestaurantsService } from './restaurants.service';
import { Restaurant, RestaurantSchema } from './schemas/restaurant.schema';

@Module({
  imports: [
    CacheModule,
    SecurityModule,
    MongooseModule.forFeature([
      { name: Restaurant.name, schema: RestaurantSchema },
      // Se registra también acá porque al borrar un restaurante se borra su carta.
      { name: MenuItem.name, schema: MenuItemSchema },
    ]),
  ],
  controllers: [RestaurantsController],
  providers: [RestaurantsService],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
