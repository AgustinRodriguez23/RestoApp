import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OBJECT_ID_REGEX } from '../../common/pipes/parse-object-id.pipe';

/** Copia del enum de reservations-service (el contrato entre servicios es el valor, no el código). */
export enum ReservationStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  EXPIRED = 'EXPIRED',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
}

export class CreateReservationDto {
  @ApiProperty({ example: '64b7f0c2a1b2c3d4e5f60718' })
  @Matches(OBJECT_ID_REGEX, { message: 'restaurantId no tiene un formato válido' })
  restaurantId: string;

  @ApiProperty({ minimum: 1, maximum: 50, example: 4 })
  @IsInt()
  @Min(1)
  @Max(50)
  partySize: number;

  @ApiProperty({ example: '2026-10-16T21:00:00-03:00', description: 'ISO 8601 con zona horaria' })
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/, { message: 'startsAt tiene que incluir la zona horaria (Z o ±HH:mm)' })
  startsAt: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class ListMyReservationsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ enum: ReservationStatus })
  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;
}

export class PayReservationDto {
  @ApiProperty({
    example: 'tok_approved',
    description: 'Medio de pago tokenizado. Con la pasarela simulada: tok_approved, tok_declined, tok_insufficient_funds, tok_error, tok_slow, tok_slow_declined, tok_slow_duplicate.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  token: string;
}
