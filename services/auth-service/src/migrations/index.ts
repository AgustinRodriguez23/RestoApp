import { InitialSchema1761700000000 } from './1761700000000-InitialSchema';
import { OwnerRequests1793700000000 } from './1793700000000-OwnerRequests';
import { Outbox1793800000000 } from './1793800000000-Outbox';

/** Todas las migraciones, en orden. Al generar una nueva hay que sumarla acá (ver "Migraciones" en docs/ARQUITECTURA.md). */
export const migrations = [InitialSchema1761700000000, OwnerRequests1793700000000, Outbox1793800000000];
