import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ApiError } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sifon text-white hover:bg-sifon-dark disabled:bg-line disabled:text-muted',
  secondary: 'bg-surface text-ink border border-line hover:border-sifon hover:text-sifon-dark disabled:text-muted',
  danger: 'bg-danger text-white hover:brightness-95 disabled:bg-line disabled:text-muted',
  ghost: 'text-sifon-dark hover:bg-sifon-soft disabled:text-muted',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? 'size-4' : 'size-6';
  return <span role="status" aria-label="Cargando" className={`${size} inline-block animate-spin rounded-full border-2 border-current border-t-transparent`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium">
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-muted/70 focus:border-sifon';

/** Error de una acción o carga, con qué pasó y cómo seguir. Si el servidor mandó un id de seguimiento, se muestra. */
export function ErrorNotice({ error, onRetry, title = 'No pudimos cargar esto' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof Error ? error.message : 'Ocurrió un error inesperado.';
  const trace = error instanceof ApiError ? error.correlationId : undefined;
  return (
    <div role="alert" className="grid gap-2 rounded-xl border border-danger/30 bg-danger-soft p-4 text-danger">
      <p className="font-semibold">{title}</p>
      <p className="text-sm">{message}</p>
      {trace && <p className="text-xs opacity-80">Código de seguimiento: {trace}</p>}
      {onRetry && (
        <div>
          <Button variant="secondary" onClick={onRetry} className="min-h-9">
            Reintentar
          </Button>
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-3 rounded-xl border border-dashed border-line p-6">
      <p className="font-display text-lg font-semibold">{title}</p>
      {children}
    </div>
  );
}
