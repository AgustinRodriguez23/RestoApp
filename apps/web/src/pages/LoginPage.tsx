import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
      navigate(from, { replace: true });
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

      <form onSubmit={submit} className="grid gap-4" noValidate={false}>
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
    </div>
  );
}
