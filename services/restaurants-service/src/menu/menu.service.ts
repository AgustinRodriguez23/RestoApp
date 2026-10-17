import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { CacheService } from '../cache/cache.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { MenuItem, MenuItemDocument } from './schemas/menu-item.schema';

export interface MenuCategory {
  category: string;
  items: MenuItemDocument[];
}

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(MenuItem.name) private readonly items: Model<MenuItemDocument>,
    private readonly restaurants: RestaurantsService,
    private readonly cache: CacheService,
  ) {}

  async addItem(
    restaurantId: string,
    userId: string,
    dto: CreateMenuItemDto,
  ): Promise<MenuItemDocument> {
    await this.restaurants.findOwned(restaurantId, userId);
    const created = await this.items.create({ ...dto, restaurantId: new Types.ObjectId(restaurantId) });
    await this.cache.invalidate();
    return created;
  }

  /** La carta completa, agrupada por categoría. Por defecto solo los platos disponibles. */
  async getMenu(restaurantId: string, includeUnavailable = false): Promise<MenuCategory[]> {
    const key = CacheService.key('menu', restaurantId, includeUnavailable);
    return this.cache.wrap(key, () => this.loadMenu(restaurantId, includeUnavailable));
  }

  private async loadMenu(restaurantId: string, includeUnavailable: boolean): Promise<MenuCategory[]> {
    await this.restaurants.findOne(restaurantId); // 404 si el restaurante no existe

    const filter: FilterQuery<MenuItemDocument> = {
      restaurantId: new Types.ObjectId(restaurantId),
    };
    if (!includeUnavailable) filter.available = true;

    const items = await this.items.find(filter).sort({ category: 1, name: 1 });

    const byCategory = new Map<string, MenuItemDocument[]>();
    for (const item of items) {
      const list = byCategory.get(item.category) ?? [];
      list.push(item);
      byCategory.set(item.category, list);
    }
    return Array.from(byCategory, ([category, categoryItems]) => ({
      category,
      items: categoryItems,
    }));
  }

  async updateItem(
    restaurantId: string,
    itemId: string,
    userId: string,
    dto: UpdateMenuItemDto,
  ): Promise<MenuItemDocument> {
    await this.restaurants.findOwned(restaurantId, userId);

    // Se filtra también por restaurantId: un dueño no puede tocar platos de otro restaurante
    // aunque conozca el id del plato.
    const item = await this.items.findOneAndUpdate(
      { _id: itemId, restaurantId: new Types.ObjectId(restaurantId) },
      dto,
      { new: true, runValidators: true },
    );
    if (!item) throw new NotFoundException('Plato no encontrado');
    await this.cache.invalidate();
    return item;
  }

  async removeItem(restaurantId: string, itemId: string, userId: string): Promise<void> {
    await this.restaurants.findOwned(restaurantId, userId);

    const deleted = await this.items.findOneAndDelete({
      _id: itemId,
      restaurantId: new Types.ObjectId(restaurantId),
    });
    if (!deleted) throw new NotFoundException('Plato no encontrado');
    await this.cache.invalidate();
  }
}
