import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { MenuItem, MenuItemDocument } from '../menu/schemas/menu-item.schema';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { ListRestaurantsQueryDto } from './dto/list-restaurants-query.dto';
import { UpdateRestaurantDto } from './dto/update-restaurant.dto';
import { Restaurant, RestaurantDocument } from './schemas/restaurant.schema';

/** Escapa los caracteres especiales de regex para que lo que escribe el usuario se busque literal. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectModel(Restaurant.name) private readonly model: Model<RestaurantDocument>,
    @InjectModel(MenuItem.name) private readonly menuItems: Model<MenuItemDocument>,
  ) {}

  async create(ownerId: string, dto: CreateRestaurantDto): Promise<RestaurantDocument> {
    this.validateBusinessRules(dto);
    return this.model.create({ ...dto, ownerId });
  }

  async findAll(query: ListRestaurantsQueryDto) {
    const { page = 1, limit = 10, search, cuisine } = query;

    const filter: FilterQuery<RestaurantDocument> = {};
    if (search) filter.name = { $regex: escapeRegExp(search), $options: 'i' };
    if (cuisine) filter.cuisine = { $regex: `^${escapeRegExp(cuisine)}$`, $options: 'i' };

    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.model.countDocuments(filter),
    ]);

    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string): Promise<RestaurantDocument> {
    const restaurant = await this.model.findById(id);
    if (!restaurant) throw new NotFoundException('Restaurante no encontrado');
    return restaurant;
  }

  /** Devuelve el restaurante solo si existe y pertenece al usuario. Lo reutiliza el módulo de carta. */
  async findOwned(id: string, userId: string): Promise<RestaurantDocument> {
    const restaurant = await this.findOne(id);
    if (restaurant.ownerId !== userId) {
      throw new ForbiddenException('No sos el dueño de este restaurante');
    }
    return restaurant;
  }

  async update(id: string, userId: string, dto: UpdateRestaurantDto): Promise<RestaurantDocument> {
    await this.findOwned(id, userId);
    this.validateBusinessRules(dto);

    const updated = await this.model.findByIdAndUpdate(id, dto, {
      new: true,
      runValidators: true,
    });
    if (!updated) throw new NotFoundException('Restaurante no encontrado');
    return updated;
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findOwned(id, userId);
    // Mongo no tiene transacciones entre colecciones tan simples como un ON DELETE CASCADE:
    // se borra primero la carta y después el restaurante.
    await this.menuItems.deleteMany({ restaurantId: new Types.ObjectId(id) });
    await this.model.findByIdAndDelete(id);
  }

  /** Reglas que no se pueden expresar con decoradores de validación. */
  private validateBusinessRules(dto: Partial<CreateRestaurantDto>): void {
    if (dto.tables) {
      const numbers = dto.tables.map((t) => t.number);
      if (new Set(numbers).size !== numbers.length) {
        throw new BadRequestException('Hay números de mesa repetidos');
      }
    }
    if (dto.openingHours?.some((h) => h.opens === h.closes)) {
      throw new BadRequestException('Un turno no puede abrir y cerrar a la misma hora');
    }
  }
}
