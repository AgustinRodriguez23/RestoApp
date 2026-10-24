import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useUnreadCount } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { Toasts } from './Toasts';

const navLink = ({ isActive }: { isActive: boolean }) =>
  `shrink-0 whitespace-nowrap rounded-md px-2 py-2 text-sm font-semibold sm:px-3 ${isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:text-white'}`;

/** Campanita con el contador de sin leer; lleva a la bandeja. */
function NotificationsBell() {
  const { data: count = 0 } = useUnreadCount(true);
  const label = count > 0 ? `Notificaciones, ${count} sin leer` : 'Notificaciones';
  return (
    <Link to="/notificaciones" aria-label={label} className="relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-md hover:bg-white/15">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-4 text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto]">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3">
          <Link to="/" className="font-display text-xl font-bold tracking-tight">
            RestoApp
          </Link>
          {/* En móvil la navegación baja a su propia fila (logo y sesión arriba) y, si no entra, se desliza de costado */}
          <nav aria-label="Principal" className="-mx-2 order-last flex w-full gap-0.5 sm:gap-1 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible">
            <NavLink to="/" end className={navLink}>
              Restaurantes
            </NavLink>
            {user && (
              <NavLink to="/reservas" className={navLink}>
                Mis reservas
              </NavLink>
            )}
            {user?.role === 'RESTAURANT_OWNER' && (
              <NavLink to="/panel" className={navLink}>
                Panel del local
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-1 text-sm sm:gap-3">
            {user ? (
              <>
                <NotificationsBell />
                <span className="max-w-[9rem] truncate text-white/80 sm:max-w-[16rem]">{user.name}</span>
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

/** Rutas del panel del dueño. El rol se vuelve a validar en el servidor: esto solo evita mostrar una pantalla que va a fallar. */
export function RequireOwner() {
  const { user } = useAuth();
  if (user?.role !== 'RESTAURANT_OWNER') return <Navigate to="/" replace />;
  return <Outlet />;
}
