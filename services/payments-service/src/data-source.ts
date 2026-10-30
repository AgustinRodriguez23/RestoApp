/**
 * DataSource para la CLI de TypeORM: generar, aplicar o revertir migraciones a mano (scripts migration:* del
 * package.json). La app no lo usa: arma la misma conexión desde app.module y aplica las migraciones al arrancar.
 */
import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { typeOrmOptions } from './database.config';

// Fuera de Nest nadie lee los .env. Corriendo con -w payments-service el directorio actual es el del servicio.
// No pisa las variables que ya existen, así que en un contenedor mandan las DB_* del compose.
for (const file of ['.env', '../../.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No existe: alcanza con las variables de entorno
  }
}

export default new DataSource({ ...typeOrmOptions(new ConfigService()), migrationsRun: false } as DataSourceOptions);
