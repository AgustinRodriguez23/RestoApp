import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ReservationStatus } from '../entities/reservation-status.enum';

/** Los estados que puede fijar el dueño del restaurante. Cancelar tiene su propio endpoint. */
export const OWNER_SETTABLE_STATUSES = [ReservationStatus.COMPLETED, ReservationStatus.NO_SHOW] as const;

export class UpdateReservationStatusDto {
  @ApiProperty({ enum: OWNER_SETTABLE_STATUSES, example: ReservationStatus.COMPLETED })
  @IsIn(OWNER_SETTABLE_STATUSES)
  status: (typeof OWNER_SETTABLE_STATUSES)[number];
}
