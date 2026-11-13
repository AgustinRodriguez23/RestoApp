import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { NotificationType } from './schemas/notification.schema';

/** Lo necesario para crear una notificación. Sale de un evento y no depende de la base de datos. */
export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Solo en los avisos de una reserva. */
  reservationId?: string;
  restaurantId?: string;
}

/**
 * Eventos de las reservas y de su seña que este servicio escucha (las routing keys de su cola).
 * `payment.refunded` lo publica payments-service; va en la misma cola porque también es sobre una reserva.
 */
export const NOTIFIABLE_EVENTS = ['reservation.confirmed', 'reservation.cancelled', 'reservation.expired', 'payment.refunded'] as const;

/** Eventos de las solicitudes para ser dueño (los publica auth-service). Van a otra cola: ver NotificationEventsConsumer. */
export const OWNER_REQUEST_EVENTS = ['owner-request.approved', 'owner-request.rejected'] as const;

const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

interface ReservationEventData {
  reservationId?: unknown;
  customerId?: unknown;
  restaurantId?: unknown;
  restaurantName?: unknown;
  startsAt?: unknown;
  partySize?: unknown;
  timeZone?: unknown;
  reason?: unknown;
  refundable?: unknown;
  depositCents?: unknown;
  /** Solo en payment.refunded. */
  amountCents?: unknown;
  currency?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * "sábado 31 de octubre a las 21:30", en la zona horaria del restaurante (no la del servidor: un contenedor corre en UTC).
 * Devuelve undefined si el evento no trae una fecha válida (eventos anteriores a que se incluyera): el mensaje se arma igual, sin fecha.
 */
export function formatWhen(startsAt: unknown, timeZone: unknown): string | undefined {
  const iso = text(startsAt);
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;

  const parts = (zone: string) =>
    new Intl.DateTimeFormat('es-AR', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

  let p: Intl.DateTimeFormatPart[];
  try {
    p = parts(text(timeZone) ?? DEFAULT_TIME_ZONE);
  } catch {
    p = parts(DEFAULT_TIME_ZONE); // zona inválida: mejor una hora razonable que perder la notificación
  }
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} de ${get('month')} a las ${get('hour')}:${get('minute')}`;
}

const people = (n: unknown) => (typeof n === 'number' && n > 0 ? `${n} ${n === 1 ? 'persona' : 'personas'}` : undefined);

/** "$ 8.000" (los centavos solo si hay). undefined si el evento no trae un monto válido: el mensaje se arma igual, sin monto. */
export function formatMoney(amountCents: unknown, currency: unknown): string | undefined {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) return undefined;
  const code = text(currency) ?? 'ARS';
  const decimals = amountCents % 100 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: code, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(decimals)} ${code}`; // moneda inválida: mejor el número solo que perder el aviso
  }
}

/** El aviso de que se devolvió la seña. El motivo cambia la explicación; el monto, si viene, va siempre. */
function refundBody(reason: unknown, amount: string | undefined): string {
  const deposit = amount ? `los ${amount} de la seña` : 'la seña';
  if (reason === 'CANCELLED_BY_CUSTOMER') return `Cancelaste con tiempo, así que te devolvimos ${deposit}.`;
  if (reason === 'CANCELLED_BY_OWNER') return `Te devolvimos ${deposit} de la reserva que canceló el restaurante.`;
  // RESERVATION_<estado>: el pago llegó cuando la reserva ya había vencido o se había cancelado
  if (typeof reason === 'string' && reason.startsWith('RESERVATION_')) {
    return `El pago llegó cuando la reserva ya no estaba activa, así que te devolvimos ${deposit}.`;
  }
  return `Te devolvimos ${deposit} de tu reserva.`;
}

/**
 * Convierte un evento en la notificación para el usuario (o null si a esa persona no hay nada que avisarle).
 * Los de la solicitud para ser dueño se arman aparte (buildOwnerRequestNotification); el resto son de reservas.
 * Lanza PoisonMessageError si el evento no sirve nunca para notificar (sin cliente o sin reserva): reintentar no lo arregla,
 * así que va a la DLQ para inspeccionarlo.
 */
export function buildNotification(envelope: EventEnvelope): NotificationDraft | null {
  if (envelope.type.startsWith('owner-request.')) return buildOwnerRequestNotification(envelope);
  const data = (envelope.data ?? {}) as ReservationEventData;
  const userId = text(data.customerId);
  const reservationId = text(data.reservationId);
  const restaurantId = text(data.restaurantId) ?? '';
  if (!userId || !reservationId) {
    throw new PoisonMessageError(`el evento ${envelope.type} no trae customerId y reservationId: no se sabe a quién avisar`);
  }

  const restaurant = text(data.restaurantName) ?? 'el restaurante';
  const when = formatWhen(data.startsAt, data.timeZone);
  const forWhen = when ? ` para el ${when}` : '';
  const base = { userId, reservationId, restaurantId };

  switch (envelope.type) {
    case 'reservation.confirmed': {
      const size = people(data.partySize);
      return {
        ...base,
        type: 'RESERVATION_CONFIRMED',
        title: 'Reserva confirmada',
        body: `Tu mesa en ${restaurant}${size ? ` para ${size}` : ''}${when ? ` el ${when}` : ''} está confirmada.`,
      };
    }

    case 'reservation.cancelled': {
      if (data.reason === 'PAYMENT_FAILED') {
        return {
          ...base,
          type: 'RESERVATION_PAYMENT_FAILED',
          title: 'No se pudo cobrar la seña',
          body: `No pudimos cobrar la seña de tu reserva en ${restaurant}${forWhen}, así que cancelamos la reserva y liberamos la mesa. Podés intentar reservar de nuevo.`,
        };
      }
      if (data.reason === 'CANCELLED_BY_OWNER') {
        const deposit = typeof data.depositCents === 'number' && data.depositCents > 0;
        const refund = deposit ? (data.refundable === true ? ' La seña se te devuelve.' : ' La seña no se devuelve.') : '';
        return {
          ...base,
          type: 'RESERVATION_CANCELLED_BY_RESTAURANT',
          title: 'El restaurante canceló tu reserva',
          body: `${restaurant.charAt(0).toUpperCase()}${restaurant.slice(1)} canceló tu reserva${forWhen}.${refund}`,
        };
      }
      return null; // CANCELLED_BY_CUSTOMER: lo hizo la propia persona, no hace falta avisarle
    }

    case 'reservation.expired':
      return {
        ...base,
        type: 'RESERVATION_EXPIRED',
        title: 'Tu reserva venció',
        body: `No se pagó la seña a tiempo, así que la mesa en ${restaurant}${forWhen} se liberó. Podés reservar de nuevo cuando quieras.`,
      };

    // Lo publica payments-service: no trae el restaurante ni la fecha, solo a quién, cuánto y por qué
    case 'payment.refunded':
      return {
        userId,
        reservationId,
        type: 'DEPOSIT_REFUNDED',
        title: 'Te devolvimos la seña',
        body: refundBody(data.reason, formatMoney(data.amountCents, data.currency)),
      };

    default:
      throw new PoisonMessageError(`tipo de evento no soportado: ${envelope.type}`);
  }
}

interface OwnerRequestEventData {
  userId?: unknown;
  restaurantName?: unknown;
  reason?: unknown;
}

/** El aviso de que un admin revisó la solicitud para ser dueño. Sin userId no se sabe a quién avisar: va a la DLQ. */
function buildOwnerRequestNotification(envelope: EventEnvelope): NotificationDraft {
  const data = (envelope.data ?? {}) as OwnerRequestEventData;
  const userId = text(data.userId);
  if (!userId) throw new PoisonMessageError(`el evento ${envelope.type} no trae userId: no se sabe a quién avisar`);
  const local = text(data.restaurantName);
  const forLocal = local ? ` para ${local}` : '';

  switch (envelope.type) {
    case 'owner-request.approved':
      return {
        userId,
        type: 'OWNER_REQUEST_APPROVED',
        title: 'Ya sos dueño de restaurante',
        body: `Aprobamos tu solicitud${forLocal}. Ya podés cargar tu restaurante desde el panel.`,
      };

    case 'owner-request.rejected': {
      const reason = text(data.reason);
      const why = reason ? ` Motivo: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}` : '';
      return {
        userId,
        type: 'OWNER_REQUEST_REJECTED',
        title: 'Tu solicitud no fue aprobada',
        body: `Revisamos tu solicitud${forLocal} y no la aprobamos.${why} Podés corregir los datos y enviarla de nuevo.`,
      };
    }

    default:
      throw new PoisonMessageError(`tipo de evento no soportado: ${envelope.type}`);
  }
}
