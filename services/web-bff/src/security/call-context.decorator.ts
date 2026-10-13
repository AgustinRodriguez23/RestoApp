import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { CORRELATION_HEADER } from '../common/correlation/correlation-id.middleware';
import { CallContext } from '../upstream/upstream-client';

/** Arma el contexto (token + correlation id) que se reenvía a los servicios: @Ctx() ctx: CallContext */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): CallContext => {
  const req = context.switchToHttp().getRequest<Request>();
  const [type, token] = req.headers.authorization?.split(' ') ?? [];
  const correlationId = req.headers[CORRELATION_HEADER];
  return {
    token: type === 'Bearer' ? token : undefined,
    correlationId: Array.isArray(correlationId) ? correlationId[0] : correlationId,
  };
});
