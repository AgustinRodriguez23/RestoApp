import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway';
import { SimulatedGateway } from './simulated-gateway';

export const SUPPORTED_PROVIDERS = ['simulated'] as const;

/**
 * Elige la pasarela según PAYMENT_PROVIDER. Para sumar Mercado Pago: escribir un `MercadoPagoGateway implements
 * PaymentGateway`, agregar su rama acá y su nombre a SUPPORTED_PROVIDERS. Nada más cambia.
 */
export function createGateway(config: ConfigService): PaymentGateway {
  const provider = config.get<string>('PAYMENT_PROVIDER') || 'simulated';

  switch (provider) {
    case 'simulated': {
      const port = config.get<string>('PORT') ?? '3004';
      return new SimulatedGateway({
        webhookSecret: config.getOrThrow<string>('GATEWAY_WEBHOOK_SECRET'),
        webhookUrl: config.get<string>('SIMULATED_WEBHOOK_URL') || `http://localhost:${port}/webhooks/gateway`,
        webhookDelayMs: Number(config.get<string>('SIMULATED_WEBHOOK_DELAY_MS') ?? 3000),
      });
    }
    default:
      throw new Error(`PAYMENT_PROVIDER="${provider}" no está soportado. Opciones: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
}

@Module({
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: createGateway,
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class GatewayModule {}
