import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { CORRELATION_HEADER } from './common/correlation/correlation-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

bootstrap();
