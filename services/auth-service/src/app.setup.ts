import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { accessLogMiddleware } from './observability/access-log.middleware';
import { correlationIdMiddleware } from './observability/correlation-id.middleware';

/**
 * Configuración HTTP común de la app. Vive aparte de main.ts para que los tests
 * levanten la aplicación con exactamente las mismas validaciones y el mismo formato de errores.
 */
export function configureApp(app: INestApplication): void {
  app.use(correlationIdMiddleware, accessLogMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // descarta propiedades que no están en el DTO
      forbidNonWhitelisted: true, // y rechaza la request si vienen de más
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
