import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDaySummary, useMyRestaurants, useOwnerCancel, useOwnerReservations, useSetReservationStatus } from '../api/hooks';
import type { OwnerReservation, ReservationStatus } from '../api/types';
import { ReservationBadge } from '../components/StatusBadge';
import { Button, EmptyState, ErrorNotice, Field, inputClass, Spinner } from '../components/ui';
import { dateInputValue, formatMoney, formatTime } from '../lib/format';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

const linkButton = 'inline-flex min-h-11 items-center rounded-lg bg-sifon px-4 text-sm font-semibold text-white hover:bg-sifon-dark';

/** Cada tarjeta del resumen es también un filtro de la lista de abajo. */
const FILTERS: { value: ReservationStatus | ''; label: string }[] = [
  { value: '', label: 'Todas' },
  { value: 'CONFIRMED', label: 'Confirmadas' },
  { value: 'PENDING_PAYMENT', label: 'Por pagar' },
  { value: 'COMPLETED', label: 'Asistieron' },
  { value: 'NO_SHOW', label: 'No vinieron' },
  { value: 'CANCELLED', label: 'Canceladas' },
  { value: 'EXPIRED', label: 'Vencidas' },
];

function Actions({ reservation }: { reservation: OwnerReservation }) {
  const dispatch = useAppDispatch();
  const setStatus = useSetReservationStatus();
  const cancel = useOwnerCancel();
  const [confirming, setConfirming] = useState(false);

  if (reservation.status !== 'CONFIRMED') return null;
  const started = new Date(reservation.startsAt).getTime() <= Date.now();
  const busy = setStatus.isPending || cancel.isPending;
  const error = setStatus.error ?? cancel.error;

  const mark = (status: 'COMPLETED' | 'NO_SHOW') =>
    setStatus.mutate(
      { id: reservation.id, status },
      { onSuccess: () => dispatch(toastActions.push('success', status === 'COMPLETED' ? 'Marcada como asistió' : 'Marcada como no vino')) },
    );

  if (confirming) {
    return (
      <div className="col-span-2 grid gap-2 sm:col-span-1">
        <p className="text-sm font-medium">¿Cancelar la reserva de {reservation.customerName ?? 'este cliente'}? Se libera la mesa y se devuelve la seña.</p>
        {error && <ErrorNotice error={error} title="No pudimos cancelar" />}
        <div className="flex gap-2">
          <Button
            variant="danger"
            busy={cancel.isPending}
            onClick={() => cancel.mutate(reservation.id, { onSuccess: () => dispatch(toastActions.push('success', 'Reserva cancelada')) })}
          >
            Sí, cancelar
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            No
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-2 grid gap-2 sm:col-span-1">
      {error && <ErrorNotice error={error} title="No pudimos actualizar la reserva" />}
      <div className="flex flex-wrap gap-2">
        {started ? (
          <>
            <Button busy={setStatus.isPending} disabled={busy} onClick={() => mark('COMPLETED')}>
              Asistió
            </Button>
            <Button variant="secondary" busy={setStatus.isPending} disabled={busy} onClick={() => mark('NO_SHOW')}>
              No vino
            </Button>
          </>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
            Cancelar
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ reservation }: { reservation: OwnerReservation }) {
  return (
    <li className="grid grid-cols-[4.25rem_1fr] gap-x-3 gap-y-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[6rem_1fr_auto] sm:items-start">
      <p className="text-2xl font-bold tabular-nums">{formatTime(reservation.startsAt)}</p>
      <div className="grid gap-1">
        <p className="font-semibold">{reservation.customerName ?? 'Cliente'}</p>
        <p className="text-sm text-muted">
          {reservation.partySize} {reservation.partySize === 1 ? 'persona' : 'personas'} · Mesa {reservation.tableNumber}
          {reservation.depositCents > 0 && ` · Seña ${formatMoney(reservation.depositCents)}`}
        </p>
        {reservation.notes && <p className="text-sm italic">“{reservation.notes}”</p>}
        <div className="mt-1">
          <ReservationBadge status={reservation.status} audience="owner" />
        </div>
      </div>
      <Actions reservation={reservation} />
    </li>
  );
}

export function OwnerPage() {
  const restaurants = useMyRestaurants();
  const [chosen, setChosen] = useState('');
  const [date, setDate] = useState(() => dateInputValue());
  const [status, setStatus] = useState<ReservationStatus | ''>('');
  const [page, setPage] = useState(1);

  // Si hay un solo local (lo común), queda elegido sin pedirle nada al dueño
  const list = restaurants.data ?? [];
  const restaurantId = chosen || list[0]?.id || '';
  const reservations = useOwnerReservations({ restaurantId, date, status, page });
  const summary = useDaySummary(restaurantId, date);

  useEffect(() => setPage(1), [restaurantId, date, status]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Panel del local</h1>
        <Link to="/panel/restaurantes/nuevo" className={linkButton}>
          Nuevo restaurante
        </Link>
      </div>

      {restaurants.isPending && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner /> Cargando tus restaurantes…
        </div>
      )}
      {restaurants.error && <ErrorNotice error={restaurants.error} onRetry={() => void restaurants.refetch()} title="No pudimos cargar tus restaurantes" />}
      {restaurants.data && list.length === 0 && (
        <EmptyState title="Todavía no tenés ningún restaurante">
          <p className="text-sm text-muted">Creá el primero y vas a ver acá las reservas de cada día.</p>
          <Link to="/panel/restaurantes/nuevo" className={linkButton}>
            Crear mi restaurante
          </Link>
        </EmptyState>
      )}

      {list.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {list.length > 1 && (
              <Field label="Restaurante">
                <select className={inputClass} value={restaurantId} onChange={(e) => setChosen(e.target.value)}>
                  {list.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Día">
              <input type="date" className={inputClass} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </Field>
          </div>
          <p className="-mt-3 text-sm">
            {list.length === 1 && <span className="mr-3 text-muted">{list[0]?.name}</span>}
            {restaurantId && (
              <Link to={`/panel/restaurantes/${restaurantId}`} className="font-semibold text-sifon-dark underline">
                Editar datos, mesas y horarios
              </Link>
            )}
            {restaurantId && (
              <Link to={`/panel/restaurantes/${restaurantId}/carta`} className="ml-4 font-semibold text-sifon-dark underline">
                Editar la carta
              </Link>
            )}
          </p>

          <div role="group" aria-label="Resumen del día y filtro por estado" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
            {FILTERS.map((filter, index) => {
              const count = filter.value === '' ? summary.data?.total : summary.data?.byStatus[filter.value];
              const active = status === filter.value;
              return (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${filter.label}: ${count ?? 'sin dato'}`}
                  onClick={() => setStatus(filter.value)}
                  className={`grid min-h-16 content-center justify-items-start gap-0.5 rounded-xl border px-3 py-2 text-left ${
                    // "Todas" ocupa el ancho completo en móvil y tablet: así los otros seis quedan en filas parejas, sin una tarjeta huérfana
                    index === 0 ? 'col-span-2 sm:col-span-3 lg:col-span-1' : ''
                  } ${
                    active ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:border-sifon'
                  }`}
                >
                  <span className="font-display text-2xl font-bold tabular-nums leading-none">{count ?? '–'}</span>
                  <span className={`text-xs font-semibold ${active ? 'text-white/85' : 'text-muted'}`}>{filter.label}</span>
                </button>
              );
            })}
          </div>

          <section aria-live="polite" aria-busy={reservations.isFetching} className="grid gap-4">
            {reservations.isPending && (
              <div className="flex items-center gap-3 text-muted">
                <Spinner /> Cargando las reservas…
              </div>
            )}
            {reservations.error && !reservations.data && (
              <ErrorNotice error={reservations.error} onRetry={() => void reservations.refetch()} title="No pudimos cargar las reservas" />
            )}
            {reservations.data && reservations.data.data.length === 0 && (
              <EmptyState title={status ? 'No hay reservas con ese estado ese día' : 'No hay reservas para ese día'} />
            )}
            <ul className="grid gap-3">
              {reservations.data?.data.map((reservation) => <Row key={reservation.id} reservation={reservation} />)}
            </ul>
            {reservations.data && reservations.data.totalPages > 1 && (
              <nav aria-label="Páginas" className="flex items-center gap-3">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Anterior
                </Button>
                <span className="text-sm text-muted">
                  Página {reservations.data.page} de {reservations.data.totalPages}
                </span>
                <Button variant="secondary" disabled={page >= reservations.data.totalPages} onClick={() => setPage(page + 1)}>
                  Siguiente
                </Button>
              </nav>
            )}
          </section>
        </>
      )}
    </div>
  );
}
