import type { PaymentStatus, ReservationStatus } from '../api/types';

const RESERVATION: Record<ReservationStatus, { label: string; tone: string }> = {
  PENDING_PAYMENT: { label: 'Falta pagar la seña', tone: 'bg-amber text-amber-ink' },
  CONFIRMED: { label: 'Confirmada', tone: 'bg-ok-soft text-ok' },
  CANCELLED: { label: 'Cancelada', tone: 'bg-danger-soft text-danger' },
  EXPIRED: { label: 'Venció sin pago', tone: 'bg-danger-soft text-danger' },
  COMPLETED: { label: 'Completada', tone: 'bg-sifon-soft text-sifon-dark' },
  NO_SHOW: { label: 'No asististe', tone: 'bg-danger-soft text-danger' },
};

const PAYMENT: Record<PaymentStatus, { label: string; tone: string }> = {
  PENDING: { label: 'Sin pagar', tone: 'bg-amber text-amber-ink' },
  PROCESSING: { label: 'Procesando el pago', tone: 'bg-sifon-soft text-sifon-dark' },
  SUCCEEDED: { label: 'Seña pagada', tone: 'bg-ok-soft text-ok' },
  FAILED: { label: 'Pago rechazado', tone: 'bg-danger-soft text-danger' },
  EXPIRED: { label: 'Pago vencido', tone: 'bg-danger-soft text-danger' },
  CANCELLED: { label: 'Pago anulado', tone: 'bg-line text-muted' },
  REFUNDED: { label: 'Seña devuelta', tone: 'bg-sifon-soft text-sifon-dark' },
};

const base = 'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold leading-none';

export function ReservationBadge({ status }: { status: ReservationStatus }) {
  const { label, tone } = RESERVATION[status];
  return <span className={`${base} ${tone}`}>{label}</span>;
}

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  const { label, tone } = PAYMENT[status];
  return <span className={`${base} ${tone}`}>{label}</span>;
}
