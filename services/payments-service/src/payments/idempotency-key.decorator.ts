import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,100}$/;

/** Lee y valida el header Idempotency-Key. Es obligatorio en los endpoints que cobran. */
export const IdempotencyKeyHeader = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(value)) {
    throw new BadRequestException(
      'Falta el header Idempotency-Key (entre 8 y 100 caracteres: letras, números, . _ : -). Generá uno nuevo por cada intento de pago, ej: un UUID.',
    );
  }
  return value;
});
