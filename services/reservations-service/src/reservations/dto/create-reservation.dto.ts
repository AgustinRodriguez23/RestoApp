import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { OBJECT_ID_REGEX } from '../../common/pipes/parse-object-id.pipe';

export class CreateReservationDto {
  @ApiProperty({ example: '64b7f0c2a1b2c3d4e5f60718', description: 'Id del restaurante (de restaurants-service)' })
  @Matches(OBJECT_ID_REGEX, { message: 'restaurantId no tiene un formato válido' })
  restaurantId: string;

  @ApiProperty({ minimum: 1, maximum: 50, example: 4, description: 'Cantidad de comensales' })
  @IsInt()
  @Min(1)
  @Max(50)
  partySize: number;

  @ApiProperty({
    example: '2026-10-16T21:00:00-03:00',
    description:
      'Fecha y hora de inicio en formato ISO 8601 CON zona horaria (Z o ±HH:mm). ' +
      'Tiene que ser múltiplo de 30 minutos (20:00, 20:30...).',
  })
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/, { message: 'startsAt tiene que incluir la zona horaria (Z o ±HH:mm)' })
  startsAt: string;

  @ApiPropertyOptional({ example: 'Cumpleaños, necesitamos una silla para bebé', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}
