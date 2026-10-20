import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from '../api/hooks';
import type { AppNotification } from '../api/types';
import { Button, EmptyState, ErrorNotice, Spinner } from '../components/ui';
import { formatDay, formatTime } from '../lib/format';

function NotificationItem({ notification }: { notification: AppNotification }) {
  const markRead = useMarkNotificationRead();
  const created = notification.createdAt;
  return (
    <li className={`grid gap-1 rounded-xl border p-4 ${notification.read ? 'border-line bg-surface' : 'border-sifon bg-sifon-soft'}`}>
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <h2 className="font-semibold">
          {!notification.read && <span className="sr-only">Sin leer: </span>}
          {notification.title}
        </h2>
        <time dateTime={created} className="text-xs text-muted sm:shrink-0">
          {formatDay(created)} · {formatTime(created)}
        </time>
      </div>
      <p className="text-sm">{notification.body}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <Link to="/reservas" className="font-semibold text-sifon-dark underline">
          Ver mis reservas
        </Link>
        {!notification.read && (
          <Button variant="ghost" className="min-h-10 !px-0 underline hover:bg-transparent" busy={markRead.isPending} onClick={() => markRead.mutate(notification.id)}>
            Marcar como leída
          </Button>
        )}
      </div>
    </li>
  );
}

export function NotificationsPage() {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, isPending, isFetching, refetch } = useNotifications({ unread: onlyUnread, page });
  const markAll = useMarkAllNotificationsRead();
  const unread = data?.unreadCount ?? 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Notificaciones</h1>
        <Button variant="secondary" disabled={unread === 0} busy={markAll.isPending} onClick={() => markAll.mutate()}>
          Marcar todas como leídas
        </Button>
      </div>

      <div role="group" aria-label="Filtrar" className="flex gap-2">
        {[
          { value: false, label: 'Todas' },
          { value: true, label: 'Sin leer' },
        ].map((filter) => (
          <button
            key={filter.label}
            type="button"
            aria-pressed={onlyUnread === filter.value}
            onClick={() => {
              setOnlyUnread(filter.value);
              setPage(1);
            }}
            className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${
              onlyUnread === filter.value ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:border-sifon'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {markAll.error && <ErrorNotice error={markAll.error} title="No pudimos marcarlas como leídas" />}

      <section aria-live="polite" aria-busy={isFetching} className="grid gap-4">
        {isPending && (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Cargando tus notificaciones…
          </div>
        )}
        {error && !data && <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar tus notificaciones" />}
        {data && data.data.length === 0 && (
          <EmptyState title={onlyUnread ? 'No tenés notificaciones sin leer' : 'Todavía no tenés notificaciones'}>
            Te avisamos acá cuando se confirme, se cancele o venza una reserva.
          </EmptyState>
        )}
        {data && data.data.length > 0 && (
          <ul className="grid gap-3">
            {data.data.map((notification) => (
              <NotificationItem key={notification.id} notification={notification} />
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
