import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createLogger } from './observability/json-logger';
import { configureApp } from './app.setup';

async function bootstrap() {
  // bufferLogs: los logs del arranque esperan a que esté listo el logger JSON
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(createLogger('notifications-service'));

  configureApp(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Notifications Service')
    .setDescription('Bandeja de notificaciones de la plataforma de reservas: avisa al cliente cuando cambia el estado de su reserva')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3005);
  await app.listen(port);
  Logger.log(
    `notifications-service escuchando en http://localhost:${port} (Swagger en /docs)`,
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  Logger.error(`No se pudo iniciar: ${error instanceof Error ? error.message : String(error)}`, undefined, 'Bootstrap');
  process.exit(1);
});
