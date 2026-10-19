import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCreateRestaurant, useDeleteRestaurant, useMyRestaurants, useUpdateRestaurant } from '../api/hooks';
import type { Restaurant } from '../api/types';
import { Button, ErrorNotice, Field, inputClass, Spinner } from '../components/ui';
import { DAYS, emptyForm, formFromRestaurant, repeatFirstShift, toInput, validate, type FormErrors, type RestaurantFormState } from '../lib/restaurantForm';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  ) : null;
}

function RestaurantForm({ restaurant }: { restaurant?: Restaurant }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const create = useCreateRestaurant();
  const update = useUpdateRestaurant(restaurant?.id ?? '');
  const remove = useDeleteRestaurant();
  const [form, setForm] = useState<RestaurantFormState>(() => (restaurant ? formFromRestaurant(restaurant) : emptyForm()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const saving = create.isPending || update.isPending;
  const serverError = create.error ?? update.error;

  const set = <K extends keyof RestaurantFormState>(key: K, value: RestaurantFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setTable = (i: number, patch: Partial<RestaurantFormState['tables'][number]>) =>
    set('tables', form.tables.map((t, index) => (index === i ? { ...t, ...patch } : t)));
  const setShift = (i: number, patch: Partial<RestaurantFormState['hours'][number]>) =>
    set('hours', form.hours.map((h, index) => (index === i ? { ...h, ...patch } : h)));

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const done = (message: string) => () => {
      dispatch(toastActions.push('success', message));
      void navigate('/panel');
    };
    if (restaurant) update.mutate(toInput(form), { onSuccess: done('Cambios guardados') });
    else create.mutate(toInput(form), { onSuccess: done('Restaurante creado') });
  }

  const nextTableNumber = String(Math.max(0, ...form.tables.map((t) => Number(t.number) || 0)) + 1);

  return (
    <form onSubmit={submit} noValidate className="grid gap-8">
      <section className="grid items-start gap-4 sm:grid-cols-2" aria-label="Datos del restaurante">
        <div className="grid gap-1.5">
          <Field label="Nombre">
            <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
          </Field>
          <FieldError message={errors.name} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Tipo de cocina" hint="Por ejemplo: Parrilla, Italiana, Sushi">
            <input className={inputClass} value={form.cuisine} onChange={(e) => set('cuisine', e.target.value)} maxLength={50} />
          </Field>
          <FieldError message={errors.cuisine} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Dirección">
            <input className={inputClass} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={200} />
          </Field>
          <FieldError message={errors.address} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Teléfono (opcional)">
            <input className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" />
          </Field>
          <FieldError message={errors.phone} />
        </div>
        <div className="sm:col-span-2">
          <Field label="Descripción (opcional)">
            <textarea className={`${inputClass} h-24 py-2`} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </section>

      <fieldset className="grid gap-3">
        <legend className="font-display text-lg font-semibold">Mesas</legend>
        {restaurant && (
          <p className="rounded-lg bg-amber p-3 text-sm text-amber-ink">
            Si cambiás o quitás mesas, las reservas que ya existen <strong>no se revisan</strong>: una reserva puede quedar en una mesa que ya no está.
          </p>
        )}
        {form.tables.map((table, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Field label={`Número de mesa ${i + 1}`}>
              <input className={`${inputClass} w-28`} type="number" min={1} value={table.number} onChange={(e) => setTable(i, { number: e.target.value })} />
            </Field>
            <Field label={`Capacidad de la mesa ${i + 1}`}>
              <input className={`${inputClass} w-28`} type="number" min={1} max={50} value={table.capacity} onChange={(e) => setTable(i, { capacity: e.target.value })} />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={form.tables.length === 1}
              aria-label={`Quitar la mesa ${i + 1}`}
              onClick={() => set('tables', form.tables.filter((_, index) => index !== i))}
            >
              Quitar
            </Button>
          </div>
        ))}
        <FieldError message={errors.tables} />
        <div>
          <Button type="button" variant="secondary" onClick={() => set('tables', [...form.tables, { number: nextTableNumber, capacity: '4' }])}>
            Agregar mesa
          </Button>
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="font-display text-lg font-semibold">Horarios</legend>
        <p className="text-sm text-muted">Un día puede tener varios turnos (almuerzo y cena). Si cierra después de medianoche, poné una hora de cierre menor que la de apertura.</p>
        {restaurant && (
          <p className="rounded-lg bg-amber p-3 text-sm text-amber-ink">
            Cambiar los horarios no modifica las reservas ya hechas: las que queden fuera del nuevo horario siguen vigentes.
          </p>
        )}
        {form.hours.length === 0 && <p className="text-sm text-danger">Sin horarios, nadie va a poder reservar.</p>}
        {form.hours.map((shift, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Field label={`Día del turno ${i + 1}`}>
              <select className={`${inputClass} w-40`} value={shift.dayOfWeek} onChange={(e) => setShift(i, { dayOfWeek: e.target.value })}>
                {DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Abre (turno ${i + 1})`}>
              <input className={`${inputClass} w-32`} type="time" value={shift.opens} onChange={(e) => setShift(i, { opens: e.target.value })} />
            </Field>
            <Field label={`Cierra (turno ${i + 1})`}>
              <input className={`${inputClass} w-32`} type="time" value={shift.closes} onChange={(e) => setShift(i, { closes: e.target.value })} />
            </Field>
            <Button type="button" variant="ghost" aria-label={`Quitar el turno ${i + 1}`} onClick={() => set('hours', form.hours.filter((_, index) => index !== i))}>
              Quitar
            </Button>
          </div>
        ))}
        <FieldError message={errors.hours} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => set('hours', [...form.hours, { dayOfWeek: '1', opens: '12:00', closes: '15:00' }])}>
            Agregar turno
          </Button>
          <Button type="button" variant="secondary" disabled={form.hours.length === 0} onClick={() => set('hours', repeatFirstShift(form.hours))}>
            Repetir el primer turno todos los días
          </Button>
        </div>
      </fieldset>

      {serverError && <ErrorNotice error={serverError} title="No pudimos guardar el restaurante" />}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" busy={saving}>
          {restaurant ? 'Guardar cambios' : 'Crear restaurante'}
        </Button>
        <Link to="/panel" className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:border-sifon">
          Volver al panel
        </Link>
      </div>

      {restaurant && (
        <section className="grid gap-3 rounded-xl border border-danger/30 p-4" aria-label="Eliminar restaurante">
          <h2 className="font-display text-lg font-semibold text-danger">Eliminar restaurante</h2>
          {!confirmingDelete ? (
            <div>
              <Button type="button" variant="secondary" onClick={() => setConfirmingDelete(true)}>
                Eliminar este restaurante
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <p className="text-sm">
                Se borra <strong>{restaurant.name}</strong> con toda su carta y no se puede deshacer. Las reservas existentes <strong>no se cancelan</strong>: antes de eliminarlo,
                cancelá las que sigan vigentes desde el panel.
              </p>
              {remove.error && <ErrorNotice error={remove.error} title="No pudimos eliminarlo" />}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="danger"
                  busy={remove.isPending}
                  onClick={() =>
                    remove.mutate(restaurant.id, {
                      onSuccess: () => {
                        dispatch(toastActions.push('success', 'Restaurante eliminado'));
                        void navigate('/panel');
                      },
                    })
                  }
                >
                  Sí, eliminar
                </Button>
                <Button type="button" variant="secondary" disabled={remove.isPending} onClick={() => setConfirmingDelete(false)}>
                  No
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </form>
  );
}

/** /panel/restaurantes/nuevo (sin id) y /panel/restaurantes/:id (edición). */
export function RestaurantFormPage() {
  const { id } = useParams();
  const mine = useMyRestaurants();
  const restaurant = id ? mine.data?.find((r) => r.id === id) : undefined;

  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-bold">{id ? 'Editar restaurante' : 'Nuevo restaurante'}</h1>
      {id && mine.isPending && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner /> Cargando el restaurante…
        </div>
      )}
      {id && mine.error && <ErrorNotice error={mine.error} onRetry={() => void mine.refetch()} title="No pudimos cargar el restaurante" />}
      {id && mine.data && !restaurant && (
        <p>
          No encontramos ese restaurante entre los tuyos.{' '}
          <Link to="/panel" className="font-semibold text-sifon-dark underline">
            Volver al panel
          </Link>
        </p>
      )}
      {/* key: si se pasa de un restaurante a otro, el formulario arranca de cero con los datos nuevos */}
      {(!id || restaurant) && <RestaurantForm key={restaurant?.id ?? 'nuevo'} restaurant={restaurant} />}
    </div>
  );
}
