import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsUUID } from 'class-validator';

/** Lo mismo que muestra como máximo "Mis reservas" (limit=50): una página entera en un solo pedido. */
export const MAX_RESERVATION_IDS = 50;

export class ListPaymentsQueryDto {
  @ApiProperty({
    description: `Ids de reservas separados por coma (hasta ${MAX_RESERVATION_IDS})`,
    example: '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10,9a7e2d41-1b3c-4f5e-8d6a-0c1b2a3d4e5f',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((id) => id.trim()) : value))
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_RESERVATION_IDS)
  @IsUUID('all', { each: true })
  reservationIds: string[];
}
