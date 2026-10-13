import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationStatus } from '../entities/reservation-status.enum';

/** Forma de una reserva en las respuestas (solo para documentar en Swagger). */
export class ReservationDto {
  @ApiProperty({ example: '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10' })
  id: string;

  @ApiProperty({ example: '64b7f0c2a1b2c3d4e5f60718' })
  restaurantId: string;

  @ApiProperty({ example: 2, description: 'Mesa asignada automáticamente' })
  tableNumber: number;

  @ApiProperty({ description: 'Id del usuario que reservó' })
  customerId: string;

  @ApiProperty({ example: 4 })
  partySize: number;

  @ApiProperty({ example: '2026-10-16T00:00:00.000Z' })
  startsAt: string;

  @ApiProperty({ example: '2026-10-16T01:30:00.000Z' })
  endsAt: string;

  @ApiProperty({ enum: ReservationStatus })
  status: ReservationStatus;

  @ApiPropertyOptional({ nullable: true })
  notes: string | null;

  @ApiPropertyOptional({ nullable: true })
  cancelledAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Id del usuario que canceló' })
  cancelledBy: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
