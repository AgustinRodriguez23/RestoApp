import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ReservationStatus } from '../entities/reservation-status.enum';

export class ListReservationsQueryDto {
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

  @ApiPropertyOptional({ enum: ReservationStatus })
  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;
}

/** Listado de reservas de un restaurante: además permite filtrar por día. */
export class ListRestaurantReservationsQueryDto extends ListReservationsQueryDto {
  @ApiPropertyOptional({ example: '2026-10-16', description: 'Solo las reservas de ese día (zona horaria del restaurante)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date tiene que tener formato YYYY-MM-DD' })
  date?: string;
}

/** Resumen del día: acá la fecha es obligatoria (sin día no hay qué resumir). */
export class RestaurantSummaryQueryDto {
  @ApiProperty({ example: '2026-10-16', description: 'Día a resumir (zona horaria del restaurante)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date tiene que tener formato YYYY-MM-DD' })
  date: string;
}
