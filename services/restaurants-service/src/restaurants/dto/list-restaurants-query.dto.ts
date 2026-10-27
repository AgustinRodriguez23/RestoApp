import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListRestaurantsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  @ApiPropertyOptional({ description: 'Busca por nombre (contiene, sin distinguir mayúsculas)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Tipo de cocina exacto (sin distinguir mayúsculas)', example: 'Parrilla' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  cuisine?: string;

  @ApiPropertyOptional({
    description: 'Solo estos restaurantes (ids separados por coma, hasta 50). Lo usa el BFF para nombrar los de una lista de reservas en un pedido.',
    example: '64b7f0c2a1b2c3d4e5f60718,64b7f0c2a1b2c3d4e5f60719',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((id) => id.trim()) : value))
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  ids?: string[];
}
