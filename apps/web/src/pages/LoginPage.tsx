import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDemoAccounts } from '../api/hooks';
import type { DemoRole } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorNotice, Field, inputClass } from '../components/ui';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

type Mode = 'login' | 'register';

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = isRegister ? await register({ name: name.trim(), email: email.trim(), password }) : await login(email.trim(), password);
      dispatch(toastActions.push('success', `Hola, ${user.name}`));
      void navigate(from, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-md gap-6">
      <div>
        <h1 className="text-3xl font-bold">{isRegister ? 'Creá tu cuenta' : 'Ingresá a tu cuenta'}</h1>
        <p className="mt-2 text-muted">Para reservar necesitás una cuenta. Tus reservas quedan guardadas ahí.</p>
      </div>

      <div role="tablist" aria-label="Acceso" className="grid grid-cols-2 gap-1 rounded-xl bg-line/60 p-1">
        {(['login', 'register'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={`min-h-10 rounded-lg text-sm font-semibold ${mode === value ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}
          >
            {value === 'login' ? 'Ingresar' : 'Crear cuenta'}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate={false}>
        {isRegister && (
          <Field label="Nombre">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        <Field label="Contraseña" hint={isRegister ? 'Mínimo 8 caracteres' : undefined}>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isRegister ? 8 : undefined}
            maxLength={72}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </Field>
        {error !== null && <ErrorNotice error={error} title={isRegister ? 'No pudimos crear la cuenta' : 'No pudimos ingresar'} />}
        <Button type="submit" busy={busy}>
          {isRegister ? 'Crear cuenta' : 'Ingresar'}
        </Button>
      </form>

      <DemoAccess from={from} />
    </div>
  );
}

const DEMO_OPTIONS: Record<DemoRole, { label: string; description: string }> = {
  owner: { label: 'Probar como dueño', description: 'El panel de un restaurante: reservas del día, mesas, horarios y carta.' },
  customer: { label: 'Probar como cliente', description: 'Reservar una mesa y pagar la seña (con una pasarela de prueba, sin plata real).' },
};

/**
 * Entrar sin registrarse, con una cuenta compartida de demo. Solo aparece si el servidor tiene alguna configurada.
 * El dueño va directo a su panel; el cliente, a donde quería ir (por defecto, la lista de restaurantes).
 */
function DemoAccess({ from }: { from: string }) {
  const { data: accounts = [] } = useDemoAccounts();
  const { loginAsDemo } = useAuth();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [pending, setPending] = useState<DemoRole | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (accounts.length === 0) return null;

  async function enter(role: DemoRole) {
    setError(null);
    setPending(role);
    try {
      await loginAsDemo(role);
      dispatch(toastActions.push('success', 'Entraste con la cuenta de demo. Se reinicia todas las noches.'));
      void navigate(role === 'owner' ? '/panel' : from, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="demo-title" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <h2 id="demo-title" className="font-semibold">¿Solo querés mirar?</h2>
        <p className="mt-1 text-sm text-muted">Entrá con una cuenta de demo, sin registrarte.</p>
      </div>
      <ul className="grid gap-3">
        {accounts.map((role) => (
          <li key={role} className="grid gap-1">
            <Button type="button" variant="secondary" busy={pending === role} disabled={pending !== null} onClick={() => void enter(role)}>
              {DEMO_OPTIONS[role].label}
            </Button>
            <p className="text-xs text-muted">{DEMO_OPTIONS[role].description}</p>
          </li>
        ))}
      </ul>
      {error !== null && <ErrorNotice error={error} title="No pudimos entrar a la demo" />}
    </section>
  );
}
