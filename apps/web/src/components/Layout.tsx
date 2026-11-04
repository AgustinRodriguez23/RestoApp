import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useUnreadCount } from '../api/hooks';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Toasts } from './Toasts';

const navLink = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-semibold sm:min-h-10 ${isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:text-white'}`;

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

/**
 * Header. En pantallas chicas los links se esconden detrás del botón de menú (las tres líneas) y se abren en una
 * columna; desde sm se ven siempre en fila. Es una sola <nav> que cambia con clases, no dos menús: así los links
 * existen una sola vez para los lectores de pantalla y para los tests.
 */
export function Layout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const close = () => setMenuOpen(false);

  // Escape cierra el menú y devuelve el foco al botón, para seguir con el teclado desde donde se estaba
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto]">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" onClick={close} className="font-display text-xl font-bold tracking-tight">
            RestoApp
          </Link>
          <nav
            id="navegacion"
            aria-label="Principal"
            className={`${menuOpen ? 'flex' : 'hidden'} order-last w-full flex-col gap-0.5 border-t border-white/15 pt-2 sm:order-none sm:flex sm:w-auto sm:flex-row sm:gap-1 sm:border-0 sm:pt-0`}
          >
            <NavLinks user={user} onNavigate={close} />
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-1 text-sm sm:gap-3">
            {user ? (
              <>
                <NotificationsBell />
                <span className="hidden max-w-[16rem] truncate text-white/80 sm:inline">{user.name}</span>
                <button type="button" onClick={logout} className="min-h-10 rounded-md px-3 font-semibold text-white/90 hover:bg-white/15">
                  Salir
                </button>
              </>
            ) : (
              <Link to="/ingresar" onClick={close} className="rounded-md bg-white px-3 py-2 font-semibold text-ink hover:bg-sifon-soft">
                Ingresar
              </Link>
            )}
            <button
              ref={menuButton}
              type="button"
              aria-expanded={menuOpen}
              aria-controls="navegacion"
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
              onClick={() => setMenuOpen((open) => !open)}
              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md hover:bg-white/15 sm:hidden"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
                {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
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

/** Los links según quién entró. Tocar uno cierra el menú en el celular. */
function NavLinks({ user, onNavigate }: { user: User | null; onNavigate: () => void }) {
  return (
    <>
      <NavLink to="/" end className={navLink} onClick={onNavigate}>
        Restaurantes
      </NavLink>
      {user && (
        <NavLink to="/reservas" className={navLink} onClick={onNavigate}>
          Mis reservas
        </NavLink>
      )}
      {user?.role === 'RESTAURANT_OWNER' && (
        <NavLink to="/panel" className={navLink} onClick={onNavigate}>
          Panel del local
        </NavLink>
      )}
      {user?.role === 'ADMIN' && (
        <NavLink to="/admin/solicitudes" className={navLink} onClick={onNavigate}>
          Solicitudes
        </NavLink>
      )}
      {user?.role === 'CUSTOMER' && (
        <NavLink to="/quiero-ser-dueno" className={navLink} onClick={onNavigate}>
          Quiero ser dueño
        </NavLink>
      )}
    </>
  );
}

/** Rutas que piden sesión: si no hay, se va al login y después se vuelve a donde se quería ir. */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/ingresar" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Rutas de un rol (panel del dueño, solicitudes del admin). El servidor lo vuelve a validar: esto solo evita mostrar una pantalla que va a fallar. */
export function RequireRole({ role }: { role: User['role'] }) {
  const { user } = useAuth();
  if (user?.role !== role) return <Navigate to="/" replace />;
  return <Outlet />;
}
