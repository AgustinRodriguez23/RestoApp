import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCancelReservation, useMyReservations } from '../api/hooks';
import type { Reservation, ReservationStatus } from '../api/types';
import { Comanda } from '../components/Comanda';
import { Button, EmptyState, ErrorNotice, Spinner } from '../components/ui';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

const FILTERS: { value: ReservationStatus | ''; label: string }[] = [
  { value: '', label: 'Todas' },
  { value: 'PENDING_PAYMENT', label: 'Por pagar' },
  { value: 'CONFIRMED', label: 'Confirmadas' },
  { value: 'CANCELLED', label: 'Canceladas' },
];

const CANCELLABLE: ReservationStatus[] = ['PENDING_PAYMENT', 'CONFIRMED'];

function Actions({ reservation }: { reservation: Reservation }) {
  const dispatch = useAppDispatch();
  const cancel = useCancelReservation();
  const [confirming, setConfirming] = useState(false);

  if (confirming && CANCELLABLE.includes(reservation.status)) {
    const refundNote =
      reservation.status === 'CONFIRMED' && reservation.depositCents > 0
        ? 'La seña se devuelve solo si faltan 24 horas o más.'
        : 'Se libera la mesa.';
    return (
      <div className="grid gap-2">
        <p className="text-sm font-medium">¿Cancelar esta reserva? {refundNote}</p>
        {cancel.error && <ErrorNotice error={cancel.error} title="No pudimos cancelar" />}
        <div className="flex gap-2">
          <Button
            variant="danger"
            busy={cancel.isPending}
            onClick={() =>
              cancel.mutate(reservation.id, {
                onSuccess: () => dispatch(toastActions.push('success', 'Reserva cancelada')),
              })
            }
          >
            Sí, cancelar
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={cancel.isPending}>
            No, mantenerla
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {reservation.status === 'PENDING_PAYMENT' && (
        <Link
          to={`/reservas/${reservation.id}/pagar`}
          className="inline-flex min-h-11 items-center rounded-lg bg-sifon px-4 text-sm font-semibold text-white hover:bg-sifon-dark"
        >
          Pagar seña
        </Link>
      )}
      {CANCELLABLE.includes(reservation.status) && (
        <Button variant="ghost" onClick={() => setConfirming(true)}>
          Cancelar
        </Button>
      )}
    </>
  );
}

export function ReservationsPage() {
  const [status, setStatus] = useState<ReservationStatus | ''>('');
  const { data, error, isPending, isFetching, refetch } = useMyReservations(status);

  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-bold">Mis reservas</h1>

      <div role="group" aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={status === filter.value}
            onClick={() => setStatus(filter.value)}
            className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${
              status === filter.value ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:border-sifon'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <section aria-live="polite" aria-busy={isFetching} className="grid gap-4">
        {isPending && (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Cargando tus reservas…
          </div>
        )}
        {error && !data && <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar tus reservas" />}
        {data && data.data.length === 0 && (
          <EmptyState title={status ? 'No tenés reservas con ese estado' : 'Todavía no reservaste ninguna mesa'}>
            <Link to="/" className="font-semibold text-sifon-dark underline">
              Buscar un restaurante
            </Link>
          </EmptyState>
        )}
        {data?.data.map((reservation) => (
          <Comanda key={reservation.id} reservation={reservation} actions={<Actions reservation={reservation} />} />
        ))}
      </section>
    </div>
  );
}
