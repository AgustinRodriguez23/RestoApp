import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Matches, Max, Min } from 'class-validator';
import { OBJECT_ID_REGEX } from '../../common/pipes/parse-object-id.pipe';

export class AvailabilityQueryDto {
  @ApiProperty({ example: '64b7f0c2a1b2c3d4e5f60718' })
  @Matches(OBJECT_ID_REGEX, { message: 'restaurantId no tiene un formato válido' })
  restaurantId: string;

  @ApiProperty({ example: '2026-10-16', description: 'Fecha (YYYY-MM-DD) en la zona horaria del restaurante' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date tiene que tener formato YYYY-MM-DD' })
  date: string;

  @ApiProperty({ minimum: 1, maximum: 50, example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  partySize: number;
}
