import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCreateReservation, useRestaurantOverview } from '../api/hooks';
import type { MenuItem, OpeningHours } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, EmptyState, ErrorNotice, Field, inputClass, Spinner } from '../components/ui';
import { allergenLabel, dateInputValue, formatDay, formatMoney, formatTime } from '../lib/format';
import { useAppDispatch, useAppSelector } from '../store';
import { bookingActions } from '../store/bookingSlice';
import { toastActions } from '../store/toastSlice';

const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function groupByCategory(items: MenuItem[]): [string, MenuItem[]][] {
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  return [...groups];
}

function Hours({ hours }: { hours: OpeningHours[] }) {
  if (hours.length === 0) return null;
  const sorted = [...hours].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.opens.localeCompare(b.opens));
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-semibold text-sifon-dark">Horarios de atención</summary>
      <ul className="mt-2 grid gap-1 text-muted">
        {sorted.map((h) => (
          <li key={`${h.dayOfWeek}-${h.opens}`}>
            {DAYS[h.dayOfWeek]}: {h.opens} a {h.closes}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RestaurantPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { isAuthenticated } = useAuth();
  const draft = useAppSelector((state) => state.booking);

  const today = useMemo(() => dateInputValue(0), []);
  useEffect(() => {
    dispatch(bookingActions.openRestaurant({ restaurantId: id, defaultDate: today }));
  }, [dispatch, id, today]);

  // El borrador puede ser de otro restaurante durante el primer render: se espera a que se asigne
  const ready = draft.restaurantId === id && draft.date !== '';
  const { data, error, isPending, refetch, isFetching } = useRestaurantOverview(ready ? id : '', draft.date, draft.partySize);
  const create = useCreateReservation();

  if (!ready || (isPending && !data)) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Cargando el restaurante…
      </div>
    );
  }
  if (error && !data) return <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar el restaurante" />;
  if (!data) return null;

  const { restaurant, menu, availability, warnings } = data;
  const slots = availability?.slots ?? [];
  const zone = availability?.timeZone;
  const selected = slots.find((slot) => slot.startsAt === draft.startsAt);
  const maxSeats = Math.max(0, ...restaurant.tables.map((t) => t.capacity));

  function reserve() {
    if (!isAuthenticated) {
      navigate('/ingresar', { state: { from: `/restaurantes/${id}` } });
      return;
    }
    if (!draft.startsAt) return;
    create.mutate(
      { restaurantId: id, partySize: draft.partySize, startsAt: draft.startsAt, notes: draft.notes.trim() || undefined },
      {
        onSuccess: (reservation) => {
          dispatch(bookingActions.clearSelection());
          if (reservation.status === 'PENDING_PAYMENT') {
            dispatch(toastActions.push('info', 'Mesa reservada. Pagá la seña para confirmarla.'));
            navigate(`/reservas/${reservation.id}/pagar`);
          } else {
            dispatch(toastActions.push('success', 'Reserva confirmada'));
            navigate('/reservas');
          }
        },
        onError: (e) => {
          // 409: alguien tomó el horario entre que se mostró y se reservó. Se deselecciona y se refrescan los libres.
          if ((e as { status?: number }).status === 409) {
            dispatch(bookingActions.selectSlot(null));
            void refetch();
          }
        },
      },
    );
  }

  return (
    <div className="grid gap-10">
      <section className="grid gap-3">
        <Link to="/" className="text-sm font-semibold text-sifon-dark hover:underline">
          Todos los restaurantes
        </Link>
        <h1 className="text-4xl font-bold">{restaurant.name}</h1>
        <p className="font-medium text-sifon-dark">{restaurant.cuisine}</p>
        {restaurant.description && <p className="max-w-2xl text-muted">{restaurant.description}</p>}
        <p className="text-sm text-muted">
          {restaurant.address}
          {restaurant.phone ? ` · ${restaurant.phone}` : ''}
        </p>
        <Hours hours={restaurant.openingHours} />
      </section>

      <section aria-labelledby="reservar" className="grid gap-5 rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <h2 id="reservar" className="text-2xl font-semibold">
          Reservar una mesa
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Personas" hint={maxSeats > 0 ? `Hasta ${maxSeats} por mesa` : undefined}>
            <input
              className={inputClass}
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, maxSeats)}
              value={draft.partySize}
              onChange={(e) => {
                const value = Math.trunc(Number(e.target.value));
                if (value >= 1 && value <= 50) dispatch(bookingActions.setPartySize(value));
              }}
            />
          </Field>
          <Field label="Día">
            <input
              className={inputClass}
              type="date"
              min={today}
              value={draft.date}
              onChange={(e) => e.target.value && dispatch(bookingActions.setDate(e.target.value))}
            />
          </Field>
        </div>

        <div aria-live="polite" aria-busy={isFetching} className="grid gap-3">
          <h3 className="text-base font-semibold">Horarios libres para {draft.partySize} {draft.partySize === 1 ? 'persona' : 'personas'}</h3>
          {warnings.some((w) => w.section === 'availability') && (
            <ErrorNotice error={new Error('No pudimos consultar los horarios en este momento.')} title="Horarios no disponibles" onRetry={() => void refetch()} />
          )}
          {availability && slots.length === 0 && (
            <EmptyState title="No hay horarios libres ese día">
              <p className="text-muted">Probá con otro día o con menos personas.</p>
            </EmptyState>
          )}
          {slots.length > 0 && (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
              {slots.map((slot) => {
                const active = slot.startsAt === draft.startsAt;
                return (
                  <li key={slot.startsAt}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => dispatch(bookingActions.selectSlot(active ? null : slot.startsAt))}
                      className={`grid min-h-14 w-full place-items-center rounded-lg border px-2 py-2 text-center transition-colors ${
                        active ? 'border-sifon bg-sifon text-white' : 'border-line bg-mist hover:border-sifon'
                      }`}
                    >
                      <span className="text-base font-semibold tabular-nums">{formatTime(slot.startsAt, zone)}</span>
                      <span className={`text-xs ${active ? 'text-white/85' : 'text-muted'}`}>
                        {slot.availableTables === 1 ? '1 mesa' : `${slot.availableTables} mesas`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected && (
          <div className="grid gap-4 border-t border-dashed border-line pt-5">
            <p className="text-lg">
              {formatDay(selected.startsAt, zone)} a las <strong>{formatTime(selected.startsAt, zone)} h</strong>, para {draft.partySize}.
            </p>
            <Field label="Aclaraciones (opcional)" hint="Por ejemplo: cumpleaños, silla para bebé, alergias">
              <textarea
                className={`${inputClass} h-auto min-h-20 py-2`}
                maxLength={300}
                value={draft.notes}
                onChange={(e) => dispatch(bookingActions.setNotes(e.target.value))}
              />
            </Field>
          </div>
        )}

        {create.error && <ErrorNotice error={create.error} title="No pudimos reservar" />}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={reserve} busy={create.isPending} disabled={isAuthenticated && !draft.startsAt}>
            {!isAuthenticated ? 'Ingresá para reservar' : selected ? `Reservar las ${formatTime(selected.startsAt, zone)} h` : 'Elegí un horario'}
          </Button>
          {isAuthenticated && <p className="text-sm text-muted">Después te pedimos una seña para confirmar la mesa.</p>}
        </div>
      </section>

      <section aria-labelledby="carta" className="grid gap-5">
        <h2 id="carta" className="text-2xl font-semibold">
          Carta
        </h2>
        {warnings.some((w) => w.section === 'menu') && <ErrorNotice error={new Error('No pudimos cargar la carta. Probá de nuevo en un rato.')} title="Carta no disponible" onRetry={() => void refetch()} />}
        {menu && menu.length === 0 && <p className="text-muted">Este restaurante todavía no cargó su carta.</p>}
        {menu &&
          groupByCategory(menu).map(([category, items]) => (
            <div key={category} className="grid gap-2">
              <h3 className="text-lg font-semibold">{category}</h3>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {items.map((item, index) => (
                  <li key={item.id ?? `${item.name}-${index}`} className={`flex items-start justify-between gap-4 p-4 ${item.available ? '' : 'opacity-55'}`}>
                    <div className="grid gap-0.5">
                      <p className="font-medium">
                        {item.name}
                        {!item.available && <span className="ml-2 text-xs font-semibold text-danger">No disponible hoy</span>}
                      </p>
                      {item.description && <p className="text-sm text-muted">{item.description}</p>}
                      {item.allergens.length > 0 && <p className="text-xs text-muted">Contiene: {item.allergens.map(allergenLabel).join(', ')}</p>}
                    </div>
                    <p className="font-semibold tabular-nums">{formatMoney(item.priceCents)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </section>
    </div>
  );
}
