import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

/** Copia del enum de restaurants-service (el contrato entre servicios es el valor, no el código). */
export enum Allergen {
  GLUTEN = 'GLUTEN',
  CRUSTACEANS = 'CRUSTACEANS',
  EGGS = 'EGGS',
  FISH = 'FISH',
  PEANUTS = 'PEANUTS',
  SOY = 'SOY',
  MILK = 'MILK',
  TREE_NUTS = 'TREE_NUTS',
  CELERY = 'CELERY',
  MUSTARD = 'MUSTARD',
  SESAME = 'SESAME',
  SULPHITES = 'SULPHITES',
  LUPIN = 'LUPIN',
  MOLLUSCS = 'MOLLUSCS',
}

export class MenuVariantDto {
  @ApiProperty({ example: 'Porción grande' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiProperty({ example: 150000, description: 'Diferencia de precio en centavos (puede ser negativa)' })
  @IsInt()
  @Min(-100_000_000)
  @Max(100_000_000)
  priceDeltaCents: number;
}

export class CreateMenuItemDto {
  @ApiProperty({ example: 'Platos principales' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  category: string;

  @ApiProperty({ example: 'Bife de chorizo' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 1250000, description: 'Precio en centavos (entero)' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceCents: number;

  @ApiPropertyOptional({ enum: Allergen, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(Allergen, { each: true })
  allergens?: Allergen[];

  @ApiPropertyOptional({ type: [MenuVariantDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MenuVariantDto)
  variants?: MenuVariantDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  available?: boolean;
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {}
