import { Schema } from 'mongoose';

/**
 * Cómo se serializan los documentos hacia afuera: `id` en vez de `_id` y sin `__v`.
 * Así la API se ve igual que la de auth-service (que también devuelve `id`).
 */
export function applyJsonTransform(schema: Schema): void {
  schema.set('toJSON', {
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      return ret;
    },
  });
}
