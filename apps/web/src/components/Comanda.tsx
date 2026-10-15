import type { ReactNode } from 'react';
import type { Reservation } from '../api/types';
import { formatDay, formatMoney, formatTime } from '../lib/format';
import { PaymentBadge, ReservationBadge } from './StatusBadge';

/**
 * La reserva como ticket de mozo: a la izquierda qué y cuándo, en el talón (la parte que se arranca)
 * el estado y la seña. `actions` va debajo, con lo que se puede hacer con esa reserva.
 */
export function Comanda({ reservation, actions, heading = 'h3' }: { reservation: Reservation; actions?: ReactNode; heading?: 'h2' | 'h3' }) {
  const Heading = heading;
  const { status, payment, depositCents } = reservation;
  const people = reservation.partySize === 1 ? '1 persona' : `${reservation.partySize} personas`;
  const hasDeposit = depositCents > 0;

  return (
    <article className="comanda" aria-label={`Reserva en ${reservation.restaurant?.name ?? 'restaurante'}`}>
      <div className="grid content-start gap-3 p-5">
        <Heading className="font-display text-xl font-semibold leading-tight">{reservation.restaurant?.name ?? 'Restaurante'}</Heading>
        <p className="text-base">
          <span className="font-semibold">{formatDay(reservation.startsAt)}</span>, {formatTime(reservation.startsAt)} h
        </p>
        <p className="text-sm text-muted">
          {people} · Mesa {reservation.tableNumber}
        </p>
        {reservation.notes && <p className="text-sm text-muted">“{reservation.notes}”</p>}
        {actions && <div className="mt-1 flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="comanda-stub">
        <div className="grid justify-items-start gap-2">
          <ReservationBadge status={status} />
          {payment && status !== 'CONFIRMED' && <PaymentBadge status={payment.status} />}
        </div>
        {hasDeposit && (
          <div>
            <p className="text-xs text-muted">Seña</p>
            <p className="font-display text-lg font-semibold tabular-nums">{formatMoney(depositCents, payment?.currency)}</p>
          </div>
        )}
      </div>
    </article>
  );
}
