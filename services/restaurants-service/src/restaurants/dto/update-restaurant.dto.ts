import { PartialType } from '@nestjs/swagger';
import { CreateRestaurantDto } from './create-restaurant.dto';

/** Todos los campos de CreateRestaurantDto, pero opcionales (PATCH). Conserva validaciones y Swagger. */
export class UpdateRestaurantDto extends PartialType(CreateRestaurantDto) {}
