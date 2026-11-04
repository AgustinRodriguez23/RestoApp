import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Copia de las validaciones de auth-service: un body inválido se rechaza acá, sin llamar al servicio.
 * Si cambian allá, cambiarlas acá también (hasta que exista el paquete compartido).
 */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const OWNER_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export class CreateOwnerRequestDto {
  @ApiProperty({ example: 'La Esquina de Ana', minLength: 2, maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  restaurantName: string;

  @ApiProperty({ example: 'Av. Corrientes 1234, CABA', minLength: 5, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  address: string;

  @ApiProperty({ example: '+54 11 5555-1234' })
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[\d\s()-]{8,30}$/, { message: 'phone tiene que ser un teléfono (dígitos, espacios, guiones, paréntesis)' })
  phone: string;

  @ApiPropertyOptional({ example: 'Tenemos 12 mesas y queremos tomar reservas con seña.', maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export class RejectOwnerRequestDto {
  @ApiProperty({ example: 'No pudimos verificar el local con los datos enviados.', minLength: 5, maxLength: 300 })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason: string;
}

export class ListOwnerRequestsQueryDto {
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

  @ApiPropertyOptional({ enum: OWNER_REQUEST_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(OWNER_REQUEST_STATUSES)
  status?: (typeof OWNER_REQUEST_STATUSES)[number];
}
