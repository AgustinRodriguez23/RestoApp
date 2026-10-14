import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class PayDto {
  @ApiProperty({
    example: 'tok_approved',
    description:
      'Medio de pago tokenizado. Con la pasarela simulada: tok_approved, tok_declined, tok_insufficient_funds, ' +
      'tok_error (la pasarela se cae), tok_slow / tok_slow_declined / tok_slow_duplicate (resultado por webhook a los pocos segundos).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  token: string;
}
