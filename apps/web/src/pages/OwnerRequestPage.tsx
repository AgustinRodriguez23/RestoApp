import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useCreateOwnerRequest, useMyOwnerRequest } from '../api/hooks';
import type { OwnerRequest, OwnerRequestInput } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorNotice, Field, FieldError, inputClass, Spinner } from '../components/ui';
import { formatDay } from '../lib/format';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

type FormState = Required<OwnerRequestInput>;
type FormErrors = Partial<Record<keyof FormState, string>>;

/** Las mismas reglas que valida el servidor, con mensajes en castellano y antes de mandar nada. */
function validateOwnerRequest(form: FormState): FormErrors {
  const errors: FormErrors = {};
  const name = form.restaurantName.trim();
  if (name.length < 2) errors.restaurantName = 'Escribí el nombre del local.';
  if (form.address.trim().length < 5) errors.address = 'Escribí la dirección completa.';
  if (!/^\+?[\d\s()-]{8,30}$/.test(form.phone.trim())) errors.phone = 'Escribí un teléfono, por ejemplo +54 11 5555-1234.';
  return errors;
}

function RequestForm({ previous }: { previous?: OwnerRequest }) {
  const create = useCreateOwnerRequest();
  const [form, setForm] = useState<FormState>({
    restaurantName: previous?.restaurantName ?? '',
    address: previous?.address ?? '',
    phone: previous?.phone ?? '',
    message: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateOwnerRequest(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const message = form.message.trim();
    create.mutate({ restaurantName: form.restaurantName.trim(), address: form.address.trim(), phone: form.phone.trim(), ...(message && { message }) });
  }

  return (
    <form onSubmit={submit} noValidate className="grid max-w-xl gap-4">
      <div className="grid gap-1.5">
        <Field label="Nombre del local">
          <input className={inputClass} value={form.restaurantName} onChange={(e) => set('restaurantName', e.target.value)} maxLength={100} />
        </Field>
        <FieldError message={errors.restaurantName} />
      </div>
      <div className="grid gap-1.5">
        <Field label="Dirección">
          <input className={inputClass} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={200} autoComplete="street-address" />
        </Field>
        <FieldError message={errors.address} />
      </div>
      <div className="grid gap-1.5">
        <Field label="Teléfono de contacto">
          <input className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" autoComplete="tel" maxLength={30} />
        </Field>
        <FieldError message={errors.phone} />
      </div>
      <Field label="Contanos sobre el local (opcional)" hint="Cuántas mesas tiene, qué tipo de cocina, desde cuándo está abierto…">
        <textarea className={`${inputClass} h-28 py-2`} value={form.message} onChange={(e) => set('message', e.target.value)} maxLength={1000} />
      </Field>
      {create.error && <ErrorNotice error={create.error} title="No pudimos enviar la solicitud" />}
      <div>
        <Button type="submit" busy={create.isPending}>
          Enviar solicitud
        </Button>
      </div>
    </form>
  );
}

function RequestSummary({ request }: { request: OwnerRequest }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-muted">Local</dt>
      <dd className="font-semibold">{request.restaurantName}</dd>
      <dt className="text-muted">Dirección</dt>
      <dd>{request.address}</dd>
      <dt className="text-muted">Teléfono</dt>
      <dd>{request.phone}</dd>
      <dt className="text-muted">Enviada</dt>
      <dd>{formatDay(request.createdAt)}</dd>
    </dl>
  );
}

/**
 * Aprobada: el token todavía dice CUSTOMER (el rol viaja dentro). Se pide uno nuevo una sola vez y, con el rol
 * nuevo, la página pasa sola a "ya sos dueño" y aparece el panel en la navegación.
 */
function Approved() {
  const { refreshSession } = useAuth();
  const dispatch = useAppDispatch();
  const renew = useMutation({
    mutationFn: refreshSession,
    onSuccess: () => dispatch(toastActions.push('success', 'Te aprobaron: ya podés cargar tu restaurante')),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    renew.mutate();
  }, [renew]);

  if (renew.error) return <ErrorNotice error={renew.error} onRetry={() => renew.mutate()} title="Te aprobaron, pero no pudimos activar tu panel" />;
  return (
    <p className="flex items-center gap-3 text-muted">
      <Spinner /> ¡Te aprobaron! Activando tu panel…
    </p>
  );
}

function CustomerView() {
  const { data: request, error, isPending, refetch } = useMyOwnerRequest(true);

  if (isPending) {
    return (
      <p className="flex items-center gap-3 text-muted">
        <Spinner /> Cargando tu solicitud…
      </p>
    );
  }
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar tu solicitud" />;

  if (request?.status === 'APPROVED') return <Approved />;
  if (request?.status === 'PENDING') {
    return (
      <section aria-labelledby="estado" className="grid max-w-xl gap-4 rounded-2xl border border-line bg-surface p-5">
        <h2 id="estado" className="text-xl font-semibold">
          Tu solicitud está en revisión
        </h2>
        <p className="text-muted">Te avisamos acá cuando la revisemos. Si te aprobamos, el panel del local aparece solo.</p>
        <RequestSummary request={request} />
      </section>
    );
  }

  return (
    <div className="grid gap-6">
      {request?.status === 'REJECTED' && (
        <div role="status" className="grid max-w-xl gap-1 rounded-xl border border-danger/30 bg-danger-soft p-4 text-danger">
          <p className="font-semibold">Tu solicitud anterior no fue aprobada</p>
          {request.rejectionReason && <p className="text-sm">Motivo: {request.rejectionReason}</p>}
          <p className="text-sm">Podés corregir los datos y enviarla de nuevo.</p>
        </div>
      )}
      <RequestForm previous={request ?? undefined} />
    </div>
  );
}

export function OwnerRequestPage() {
  const { user } = useAuth();

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-bold">Quiero ser dueño</h1>
        <p className="max-w-xl text-muted">
          Si tenés un restaurante, pedí una cuenta de dueño para cargarlo, armar la carta y recibir reservas con seña. Revisamos cada pedido a mano.
        </p>
      </div>
      {user?.role === 'RESTAURANT_OWNER' && (
        <div className="grid justify-items-start gap-3">
          <p>Tu cuenta ya es de dueño de restaurante.</p>
          <Link to="/panel" className="font-semibold text-sifon-dark underline">
            Ir al panel del local
          </Link>
        </div>
      )}
      {user?.role === 'ADMIN' && <p>Tu cuenta es de administrador: las solicitudes se revisan desde «Solicitudes».</p>}
      {user?.role === 'CUSTOMER' && <CustomerView />}
    </div>
  );
}
