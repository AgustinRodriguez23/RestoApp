import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { accessLogMiddleware } from './observability/access-log.middleware';
import { correlationIdMiddleware } from './observability/correlation-id.middleware';

/** Configuración HTTP común. Vive aparte de main.ts para que los tests usen exactamente la misma. */
export function configureApp(app: INestApplication): void {
  // Headers de seguridad en todas las respuestas (nosniff, no dejarse meter en iframes, sin X-Powered-By, CSP...).
  // La CSP por defecto de helmet deja andar el Swagger de /docs (scripts propios y <style> inline).
  // Sin HSTS ni upgrade-insecure-requests: los dos suponen HTTPS, y lo pone quien termine TLS (el proxy de adelante).
  // Con upgrade-insecure-requests, el Swagger abierto por IP (http://192.168…:3000/docs) pediría sus archivos por https.
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(correlationIdMiddleware, accessLogMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
}
