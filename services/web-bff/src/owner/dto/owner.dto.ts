import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { ListMyReservationsQueryDto, ReservationStatus } from '../../reservations/dto/reservations.dto';

/** Reservas de un local: lo mismo que "mis reservas" más el filtro por día. */
export class ListRestaurantReservationsQueryDto extends ListMyReservationsQueryDto {
  @ApiPropertyOptional({ example: '2026-10-16', description: 'Solo las reservas de ese día (zona horaria del restaurante)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date tiene que tener formato YYYY-MM-DD' })
  date?: string;
}

/** Resumen de un día: la fecha es obligatoria. */
export class RestaurantSummaryQueryDto {
  @ApiProperty({ example: '2026-10-16', description: 'Día a resumir (zona horaria del restaurante)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date tiene que tener formato YYYY-MM-DD' })
  date: string;
}

export const OWNER_SETTABLE_STATUSES = [ReservationStatus.COMPLETED, ReservationStatus.NO_SHOW] as const;

export class UpdateReservationStatusDto {
  @ApiProperty({ enum: OWNER_SETTABLE_STATUSES })
  @IsIn(OWNER_SETTABLE_STATUSES)
  status: (typeof OWNER_SETTABLE_STATUSES)[number];
}
