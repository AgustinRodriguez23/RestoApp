import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createLogger } from './observability/json-logger';
import { configureApp } from './app.setup';

async function bootstrap() {
  // bufferLogs: los logs del arranque esperan a que esté listo el logger JSON
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(createLogger('restaurants-service'));

  configureApp(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Restaurants Service')
    .setDescription('Restaurantes, mesas, horarios y carta de la plataforma de reservas')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  Logger.log(
    `restaurants-service escuchando en http://localhost:${port} (Swagger en /docs)`,
    'Bootstrap',
  );
}

bootstrap();
