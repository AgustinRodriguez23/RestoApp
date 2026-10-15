import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Toasts } from './Toasts';

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-semibold ${isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:text-white'}`;

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr_auto]">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="font-display text-xl font-bold tracking-tight">
            Reservas
          </Link>
          <nav aria-label="Principal" className="flex gap-1">
            <NavLink to="/" end className={navLink}>
              Restaurantes
            </NavLink>
            {user && (
              <NavLink to="/reservas" className={navLink}>
                Mis reservas
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span className="text-white/80">{user.name}</span>
                <button type="button" onClick={logout} className="rounded-md px-3 py-2 font-semibold text-white/90 hover:bg-white/15">
                  Salir
                </button>
              </>
            ) : (
              <Link to="/ingresar" className="rounded-md bg-white px-3 py-2 font-semibold text-ink hover:bg-sifon-soft">
                Ingresar
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <Outlet />
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-muted">Proyecto de portfolio · pagos simulados, no se cobra dinero real</footer>
      <Toasts />
    </div>
  );
}

/** Rutas que piden sesión: si no hay, se va al login y después se vuelve a donde se quería ir. */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/ingresar" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}
