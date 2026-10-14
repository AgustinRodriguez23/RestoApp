import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { InvalidWebhookError } from '../gateway/payment-gateway';
import { WebhooksService } from './webhooks.service';

/**
 * Endpoint al que llama la PASARELA (no el navegador), por eso no usa JWT: se autentica con la firma HMAC del
 * cuerpo. Necesita el cuerpo crudo (rawBody) porque la firma se calcula sobre los bytes exactos recibidos.
 */
@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('gateway')
  @HttpCode(HttpStatus.OK)
  async gateway(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string | string[] | undefined>) {
    if (!req.rawBody) throw new BadRequestException('Falta el cuerpo del webhook');

    try {
      const result = await this.webhooks.handle(req.rawBody, headers);
      return { received: true, result };
    } catch (error) {
      if (error instanceof InvalidWebhookError) throw new UnauthorizedException(error.message);
      if (error instanceof SyntaxError) throw new BadRequestException('El cuerpo del webhook no es JSON válido');
      throw error;
    }
  }
}
