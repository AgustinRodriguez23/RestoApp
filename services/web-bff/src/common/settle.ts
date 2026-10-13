export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Convierte una promesa en un resultado que nunca falla. Se usa al agregar datos de varios servicios:
 * si una parte "opcional" se cae, se responde igual con lo que sí llegó (degradación parcial)
 * en vez de devolver error por completo.
 */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export interface Warning {
  section: string;
  message: string;
}
