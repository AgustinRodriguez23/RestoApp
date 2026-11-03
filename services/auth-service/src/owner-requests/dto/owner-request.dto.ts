import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OwnerRequestStatus } from '../owner-request.entity';

/** Saca los espacios de los costados: "   " no tiene que pasar como un nombre de local. */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

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
  // Dígitos con los separadores de siempre, y al menos 8 dígitos: no valida que el número exista, solo que lo parezca
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
  page?: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: OwnerRequestStatus, default: OwnerRequestStatus.PENDING })
  @IsOptional()
  @IsEnum(OwnerRequestStatus)
  status?: OwnerRequestStatus = OwnerRequestStatus.PENDING;
}

export class OwnerRequestApplicantDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;
}

export class OwnerRequestResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: OwnerRequestStatus })
  status: OwnerRequestStatus;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  phone: string;

  @ApiProperty({ type: String, nullable: true })
  message: string | null;

  @ApiProperty({ type: String, nullable: true })
  rejectionReason: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  reviewedAt: Date | null;

  @ApiPropertyOptional({ type: OwnerRequestApplicantDto, description: 'Quién la envió (solo en el listado del admin)' })
  applicant?: OwnerRequestApplicantDto;
}

export class OwnerRequestPageDto {
  @ApiProperty({ type: [OwnerRequestResponseDto] })
  data: OwnerRequestResponseDto[];

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  totalPages: number;
}
