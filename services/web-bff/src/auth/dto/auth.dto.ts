import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '../../security/role.enum';

/** Los roles que se pueden pedir al registrarse: una lista y no el enum, para que ADMIN nunca pase (igual que en auth-service). */
export const SELF_REGISTER_ROLES = [Role.CUSTOMER, Role.RESTAURANT_OWNER] as const;

export class LoginDto {
  @ApiProperty({ example: 'ana@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Password123' })
  @IsString()
  password: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'ana@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Ana García', minLength: 2, maxLength: 80 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: 'Password123', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @ApiPropertyOptional({ enum: SELF_REGISTER_ROLES, default: Role.CUSTOMER })
  @IsOptional()
  @IsIn(SELF_REGISTER_ROLES)
  role?: (typeof SELF_REGISTER_ROLES)[number];
}
