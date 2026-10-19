import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { createLogger } from './observability/json-logger';

async function bootstrap() {
  // bufferLogs: los logs del arranque esperan a que esté listo el logger JSON.
  // rawBody: guarda los bytes originales de cada request; el webhook los necesita para verificar la firma HMAC.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(createLogger('payments-service'));

  configureApp(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payments Service')
    .setDescription('Cobro de la seña de las reservas. Pasarela de pagos simulada e intercambiable.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3004);
  await app.listen(port);
  Logger.log(`payments-service escuchando en http://localhost:${port} (Swagger en /docs)`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(`No se pudo iniciar: ${error instanceof Error ? error.message : String(error)}`, undefined, 'Bootstrap');
  process.exit(1);
});
