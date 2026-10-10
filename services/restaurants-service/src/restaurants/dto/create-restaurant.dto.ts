import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class OpeningHoursDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo ... 6 = sábado', example: 5 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '12:00', description: 'Formato HH:mm' })
  @Matches(TIME_REGEX, { message: 'opens debe tener formato HH:mm' })
  opens: string;

  @ApiProperty({
    example: '23:30',
    description: 'Formato HH:mm. Si es menor que opens, cierra al día siguiente.',
  })
  @Matches(TIME_REGEX, { message: 'closes debe tener formato HH:mm' })
  closes: string;
}

export class TableDto {
  @ApiProperty({ minimum: 1, example: 1, description: 'Número de mesa, único dentro del restaurante' })
  @IsInt()
  @Min(1)
  number: number;

  @ApiProperty({ minimum: 1, maximum: 50, example: 4, description: 'Cantidad de comensales' })
  @IsInt()
  @Min(1)
  @Max(50)
  capacity: number;
}

export class CreateRestaurantDto {
  @ApiProperty({ example: 'La Parrilla de Juan' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Cortes a la parrilla y pastas caseras' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 'Parrilla' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  cuisine: string;

  @ApiProperty({ example: 'Av. Mitre 1234, Quilmes' })
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  address: string;

  @ApiPropertyOptional({ example: '+54 11 4444-5555' })
  @IsOptional()
  @Matches(/^[+\d][\d\s()-]{5,19}$/, { message: 'phone no tiene un formato válido' })
  phone?: string;

  @ApiProperty({ type: [OpeningHoursDto] })
  @IsArray()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursDto)
  openingHours: OpeningHoursDto[];

  @ApiProperty({ type: [TableDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TableDto)
  tables: TableDto[];
}
