import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { CORRELATION_HEADER } from './observability/correlation-id.middleware';
import { createLogger } from './observability/json-logger';

async function bootstrap() {
  // bufferLogs: los logs del arranque esperan a que esté listo el logger JSON
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(createLogger('web-bff'));

  // Con nginx adelante, la IP del cliente viene en X-Forwarded-For (los límites de login se cuentan por IP).
  // TRUST_PROXY=1 confía en un salto. Sin proxy no se define: si no, cualquiera inventa su IP con ese header.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  // Es el único servicio que llama el navegador, así que es el único que necesita CORS
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim()),
    exposedHeaders: [CORRELATION_HEADER],
  });
  configureApp(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Web BFF')
    .setDescription('Entrada única para el frontend: agrega datos de auth, restaurants y reservations')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`web-bff escuchando en http://localhost:${port} (Swagger en /docs)`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(`No se pudo iniciar: ${error instanceof Error ? error.message : String(error)}`, undefined, 'Bootstrap');
  process.exit(1);
});
