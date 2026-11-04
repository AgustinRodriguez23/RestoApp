import { useState } from 'react';
import { useOwnerRequests, useReviewOwnerRequest } from '../api/hooks';
import type { OwnerRequest, OwnerRequestStatus } from '../api/types';
import { Button, EmptyState, ErrorNotice, Field, FieldError, inputClass, Spinner } from '../components/ui';
import { formatDay, formatTime } from '../lib/format';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

const FILTERS: { value: OwnerRequestStatus; label: string; empty: string }[] = [
  { value: 'PENDING', label: 'Pendientes', empty: 'No hay solicitudes para revisar' },
  { value: 'APPROVED', label: 'Aprobadas', empty: 'Todavía no se aprobó ninguna' },
  { value: 'REJECTED', label: 'Rechazadas', empty: 'Todavía no se rechazó ninguna' },
];

function RequestCard({ request }: { request: OwnerRequest }) {
  const dispatch = useAppDispatch();
  const review = useReviewOwnerRequest();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const applicant = request.applicant;

  function approve() {
    review.mutate(
      { id: request.id, decision: 'approve' },
      { onSuccess: () => dispatch(toastActions.push('success', `${applicant?.name ?? 'El usuario'} ya es dueño de restaurante`)) },
    );
  }

  function reject() {
    if (reason.trim().length < 5) {
      setReasonError('Contale por qué, en al menos 5 letras: lo va a leer.');
      return;
    }
    setReasonError(undefined);
    review.mutate(
      { id: request.id, decision: 'reject', reason: reason.trim() },
      { onSuccess: () => dispatch(toastActions.push('info', 'Solicitud rechazada')) },
    );
  }

  return (
    <li className="grid gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <h2 className="text-lg font-semibold">{request.restaurantName}</h2>
        <time dateTime={request.createdAt} className="text-xs text-muted sm:shrink-0">
          Enviada el {formatDay(request.createdAt)} · {formatTime(request.createdAt)}
        </time>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {applicant && (
          <>
            <dt className="text-muted">Quién</dt>
            <dd className="min-w-0 break-words">
              {applicant.name} · {applicant.email}
            </dd>
          </>
        )}
        <dt className="text-muted">Dirección</dt>
        <dd>{request.address}</dd>
        <dt className="text-muted">Teléfono</dt>
        <dd>{request.phone}</dd>
        {request.message && (
          <>
            <dt className="text-muted">Mensaje</dt>
            <dd className="whitespace-pre-line">{request.message}</dd>
          </>
        )}
        {request.rejectionReason && (
          <>
            <dt className="text-muted">Motivo del rechazo</dt>
            <dd>{request.rejectionReason}</dd>
          </>
        )}
      </dl>

      {review.error && <ErrorNotice error={review.error} title="No pudimos guardar la revisión" />}

      {request.status === 'PENDING' && !rejecting && (
        <div className="flex flex-wrap gap-2">
          <Button busy={review.isPending} onClick={approve}>
            Aprobar
          </Button>
          <Button variant="secondary" disabled={review.isPending} onClick={() => setRejecting(true)}>
            Rechazar
          </Button>
        </div>
      )}
      {request.status === 'PENDING' && rejecting && (
        <div className="grid gap-2">
          <div className="grid gap-1.5">
            <Field label="Motivo del rechazo" hint="Lo ve quien hizo la solicitud.">
              <textarea className={`${inputClass} h-20 py-2`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
            <FieldError message={reasonError} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" busy={review.isPending} onClick={reject}>
              Confirmar rechazo
            </Button>
            <Button variant="ghost" disabled={review.isPending} onClick={() => setRejecting(false)}>
              Volver
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function AdminRequestsPage() {
  const [status, setStatus] = useState<OwnerRequestStatus>('PENDING');
  const [page, setPage] = useState(1);
  const { data, error, isPending, isFetching, refetch } = useOwnerRequests({ status, page });
  const emptyTitle = FILTERS.find((f) => f.value === status)?.empty ?? 'No hay solicitudes';

  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-bold">Solicitudes para ser dueño</h1>

      <div role="group" aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={status === f.value}
            onClick={() => {
              setStatus(f.value);
              setPage(1);
            }}
            className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${
              status === f.value ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:border-sifon'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section aria-live="polite" aria-busy={isFetching} className="grid gap-4">
        {isPending && (
          <p className="flex items-center gap-3 text-muted">
            <Spinner /> Cargando solicitudes…
          </p>
        )}
        {error && !data && <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar las solicitudes" />}
        {data && data.data.length === 0 && <EmptyState title={emptyTitle} />}
        {data && data.data.length > 0 && (
          <ul className="grid gap-3">
            {data.data.map((request) => (
              <RequestCard key={request.id} request={request} />
            ))}
          </ul>
        )}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between gap-3">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Anteriores
            </Button>
            <span className="text-sm text-muted">
              Página {data.page} de {data.totalPages}
            </span>
            <Button variant="secondary" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>
              Siguientes
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
