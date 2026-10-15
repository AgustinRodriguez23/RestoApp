import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isSettling, usePayReservation, useReservation } from '../api/hooks';
import { Comanda } from '../components/Comanda';
import { Button, ErrorNotice, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { formatMoney, newIdempotencyKey, remaining } from '../lib/format';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

/** Medios de prueba de la pasarela simulada. Con una pasarela real acá iría el formulario de tarjeta tokenizado. */
export const TEST_CARDS = [
  { token: 'tok_approved', label: 'Tarjeta aprobada', hint: 'El pago se aprueba al instante' },
  { token: 'tok_declined', label: 'Tarjeta rechazada', hint: 'El banco rechaza el pago: la reserva se cancela' },
  { token: 'tok_insufficient_funds', label: 'Sin fondos', hint: 'Rechazo por fondos insuficientes' },
  { token: 'tok_slow', label: 'Pago lento', hint: 'La pasarela tarda unos segundos y avisa después' },
  { token: 'tok_error', label: 'Pasarela caída', hint: 'No se cobra nada: se puede reintentar' },
] as const;

/** Segundos que faltan, redibujados cada 1 s. */
function useCountdown(deadline: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline ? remaining(deadline, now) : null;
}

export function PaymentPage() {
  const { id = '' } = useParams();
  const dispatch = useAppDispatch();
  const { data: reservation, error, isPending, refetch } = useReservation(id);
  const pay = usePayReservation();
  const [token, setToken] = useState<string>(TEST_CARDS[0].token);
  const timeLeft = useCountdown(reservation?.status === 'PENDING_PAYMENT' ? reservation.expiresAt : null);

  // La clave de idempotencia identifica "este intento de pago". Se conserva mientras el pedido sea el mismo
  // (reintentar tras un corte no puede cobrar dos veces) y cambia solo si cambia el medio de pago:
  // con la misma clave y otro contenido, el servidor lo rechaza a propósito.
  const attempt = useRef<{ token: string; key: string } | null>(null);
  function keyFor(selected: string): string {
    if (attempt.current?.token !== selected) attempt.current = { token: selected, key: newIdempotencyKey() };
    return attempt.current.key;
  }

  // Aviso único cuando la reserva se confirma mientras se está mirando esta pantalla
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reservation && lastStatus.current === 'PENDING_PAYMENT' && reservation.status === 'CONFIRMED') {
      dispatch(toastActions.push('success', 'Pago recibido. ¡Reserva confirmada!'));
    }
    lastStatus.current = reservation?.status;
  }, [reservation, dispatch]);

  if (isPending) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Cargando tu reserva…
      </div>
    );
  }
  if (error || !reservation) return <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar la reserva" />;

  const payment = reservation.payment;
  const settling = isSettling(reservation);
  const processing = pay.data?.processing || payment?.status === 'PROCESSING';
  const amount = formatMoney(reservation.depositCents, payment?.currency);
  const retryable = pay.error instanceof ApiError && (pay.error.status === 0 || pay.error.status >= 500);

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-3xl font-bold">
        {reservation.status === 'CONFIRMED' ? 'Reserva confirmada' : reservation.status === 'PENDING_PAYMENT' ? 'Pagá la seña para confirmar' : 'Esta reserva ya no se puede pagar'}
      </h1>

      <Comanda reservation={reservation} heading="h2" />

      {reservation.status === 'CONFIRMED' && (
        <div className="grid justify-items-start gap-3 rounded-xl bg-ok-soft p-5 text-ok">
          <p className="font-semibold">Recibimos la seña de {amount}. Tu mesa está asegurada.</p>
          <p className="text-sm">Si cancelás con 24 horas o más de anticipación, te devolvemos la seña.</p>
          <Link to="/reservas" className="font-semibold underline">
            Ver mis reservas
          </Link>
        </div>
      )}

      {reservation.status === 'PENDING_PAYMENT' && settling && (
        <div role="status" className="flex items-center gap-3 rounded-xl bg-sifon-soft p-5 text-sifon-dark">
          <Spinner />
          <p className="font-medium">
            {processing ? 'La pasarela está procesando tu pago. Esto tarda unos segundos…' : 'Pago registrado. Estamos confirmando tu reserva…'}
          </p>
        </div>
      )}

      {reservation.status === 'PENDING_PAYMENT' && !settling && (
        <form
          className="grid gap-5 rounded-2xl border border-line bg-surface p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate({ reservationId: id, token, idempotencyKey: keyFor(token) });
          }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-display text-2xl font-semibold tabular-nums">{amount}</p>
            <p className={`text-sm font-medium ${timeLeft ? 'text-amber-ink' : 'text-danger'}`}>
              {timeLeft ? `Mesa retenida: ${timeLeft} para pagar` : 'El plazo venció: actualizá para ver el estado'}
            </p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">Medio de pago de prueba</legend>
            <p className="mb-1 text-xs text-muted">Es una pasarela simulada: elegí qué querés que pase. No se cobra dinero real.</p>
            {TEST_CARDS.map((card) => (
              <label
                key={card.token}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${token === card.token ? 'border-sifon bg-sifon-soft' : 'border-line hover:border-sifon'}`}
              >
                <input type="radio" name="token" className="mt-1 accent-sifon" value={card.token} checked={token === card.token} onChange={() => setToken(card.token)} />
                <span className="grid">
                  <span className="font-medium">{card.label}</span>
                  <span className="text-sm text-muted">{card.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {pay.data && !pay.data.processing && pay.data.payment.status === 'FAILED' && (
            <ErrorNotice
              error={new Error(pay.data.payment.failureReason ?? 'La pasarela rechazó el pago.')}
              title="Pago rechazado. La reserva se cancela y la mesa queda libre."
            />
          )}
          {pay.error && (
            <ErrorNotice
              error={pay.error}
              title={retryable ? 'No se pudo completar el pago. No se cobró nada: podés reintentar.' : 'No se pudo procesar el pago'}
            />
          )}

          <Button type="submit" busy={pay.isPending} disabled={!timeLeft}>
            Pagar {amount}
          </Button>
        </form>
      )}

      {(reservation.status === 'CANCELLED' || reservation.status === 'EXPIRED') && (
        <div className="grid justify-items-start gap-3 rounded-xl bg-danger-soft p-5 text-danger">
          <p className="font-semibold">
            {reservation.status === 'EXPIRED' ? 'Pasó el plazo para pagar y liberamos la mesa.' : 'La reserva está cancelada y la mesa quedó libre.'}
          </p>
          {payment?.failureReason && <p className="text-sm">Motivo: {payment.failureReason}</p>}
          <Link to={`/restaurantes/${reservation.restaurantId}`} className="font-semibold underline">
            Reservar otro horario
          </Link>
        </div>
      )}
    </div>
  );
}
