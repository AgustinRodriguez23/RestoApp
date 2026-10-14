import { AsyncLocalStorage } from 'node:async_hooks';

/** Datos que acompañan a UNA request mientras se procesa, sin pasarlos de función en función. */
export interface RequestContext {
  correlationId: string;
  /** Se completa cuando el guard valida el JWT. */
  userId?: string;
}

/**
 * AsyncLocalStorage es "una variable global POR REQUEST": cualquier código que corra como parte
 * de esa request (aunque pase por await, promesas o timers) ve su propio contexto, y dos requests
 * simultáneas nunca se mezclan. Gracias a esto el logger agrega el correlationId solo, y los
 * clientes HTTP lo reenvían a otros servicios sin que nadie lo reciba por parámetro.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Lo llama el guard de JWT: desde ahí, todos los logs de la request incluyen el userId. */
export function setCurrentUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}
