import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { NotificationType } from './schemas/notification.schema';

/** Lo necesario para crear una notificación. Sale de un evento y no depende de la base de datos. */
export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  reservationId: string;
  restaurantId: string;
}

/** Tipos de evento que este servicio escucha (las routing keys de la cola). */
export const NOTIFIABLE_EVENTS = ['reservation.confirmed', 'reservation.cancelled', 'reservation.expired'] as const;

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

/**
 * Convierte un evento de reserva en la notificación para el cliente (o null si a esa persona no hay nada que avisarle).
 * Lanza PoisonMessageError si el evento no sirve nunca para notificar (sin cliente o sin reserva): reintentar no lo arregla,
 * así que va a la DLQ para inspeccionarlo.
 */
export function buildNotification(envelope: EventEnvelope): NotificationDraft | null {
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

    default:
      throw new PoisonMessageError(`tipo de evento no soportado: ${envelope.type}`);
  }
}
