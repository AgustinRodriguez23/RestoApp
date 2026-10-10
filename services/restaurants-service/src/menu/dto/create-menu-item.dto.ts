import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Allergen } from '../schemas/menu-item.schema';

export class MenuVariantDto {
  @ApiProperty({ example: 'Porción grande' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiProperty({
    example: 150000,
    description: 'Diferencia de precio en centavos respecto del plato base (puede ser negativa)',
  })
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

  @ApiPropertyOptional({ example: 'Con papas rústicas' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 1250000, description: 'Precio en centavos (entero): 12500,00 → 1250000' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceCents: number;

  @ApiPropertyOptional({ enum: Allergen, isArray: true, example: ['GLUTEN', 'MILK'] })
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

  @ApiPropertyOptional({ default: true, description: 'false = no se muestra en la carta pública' })
  @IsOptional()
  @IsBoolean()
  available?: boolean;
}
