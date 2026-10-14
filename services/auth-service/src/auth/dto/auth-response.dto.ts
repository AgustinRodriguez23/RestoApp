import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../users/role.enum';

export class UserResponseDto {
  @ApiProperty({ example: '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10' })
  id: string;

  @ApiProperty({ example: 'ana@example.com' })
  email: string;

  @ApiProperty({ example: 'Ana García' })
  name: string;

  @ApiProperty({ enum: Role })
  role: Role;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT para enviar como Authorization: Bearer <token>' })
  accessToken: string;

  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;
}
