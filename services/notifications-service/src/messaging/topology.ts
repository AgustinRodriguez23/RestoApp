/**
 * Nombres fijos de la topología de RabbitMQ. Son parte del "contrato" entre servicios:
 * si cambian acá, tienen que cambiar igual en todos.
 */

/** Exchange (buzón central) donde se publican TODOS los eventos. Tipo "topic": cada cola elige qué tipos recibe. */
export const EVENTS_EXCHANGE = 'reservas.events';

/** Sufijos de las colas auxiliares que se crean por cada cola de trabajo. */
export const retryQueueOf = (queue: string) => `${queue}.retry`;
export const deadLetterQueueOf = (queue: string) => `${queue}.dlq`;

/** Headers que viajan con cada mensaje. */
export const HEADER_CORRELATION_ID = 'x-correlation-id';
export const HEADER_ATTEMPT = 'x-attempt';
export const HEADER_ERROR = 'x-error';
export const HEADER_ORIGINAL_ROUTING_KEY = 'x-original-routing-key';
