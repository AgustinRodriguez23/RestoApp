import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CacheModule } from '../cache/cache.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { SecurityModule } from '../security/security.module';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { MenuItem, MenuItemSchema } from './schemas/menu-item.schema';

@Module({
  imports: [
    CacheModule,
    SecurityModule,
    RestaurantsModule,
    MongooseModule.forFeature([{ name: MenuItem.name, schema: MenuItemSchema }]),
  ],
  controllers: [MenuController],
  providers: [MenuService],
})
export class MenuModule {}
