import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, User } from '../api/types';
import { api, configureApi } from '../lib/api';

/**
 * Sesión del usuario, compartida por toda la app mediante Context: es un dato que casi cualquier
 * componente necesita leer y que cambia muy poco (login/logout), el caso típico de Context.
 *
 * El token se guarda en localStorage para sobrevivir a un F5. Es lo más simple, pero cualquier script
 * que corra en la página (XSS) puede leerlo; con cookies httpOnly emitidas por el BFF no sería legible.
 * Queda anotado como mejora (README).
 */
const STORAGE_KEY = 'reservas.session';

interface Session {
  token: string;
  user: User;
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    return parsed.token && parsed.user?.id ? (parsed as Session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Modo privado o almacenamiento bloqueado: la sesión dura hasta cerrar la pestaña
  }
}

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: { name: string; email: string; password: string }) => Promise<User>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(readSession);

  const start = useCallback((response: AuthResponse) => {
    const next = { token: response.accessToken, user: response.user };
    writeSession(next);
    setSession(next);
    return response.user;
  }, []);

  const logout = useCallback(() => {
    writeSession(null);
    setSession(null);
    // Lo que estaba en caché era de otro usuario: no tiene que verse en la próxima sesión
    queryClient.clear();
  }, [queryClient]);

  // Se registra durante el render (no en un efecto): así el primer fetch de un hijo ya sabe qué token usar
  configureApi({ getToken: () => session?.token ?? null, onUnauthorized: logout });

  // Si otra pestaña cierra sesión, esta también
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setSession(readSession());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      isAuthenticated: session !== null,
      login: async (email, password) => start((await api.post<AuthResponse>('/auth/login', { email, password })).data),
      register: async (input) => {
        await api.post('/auth/register', input);
        return start((await api.post<AuthResponse>('/auth/login', { email: input.email, password: input.password })).data);
      },
      logout,
    }),
    [session, start, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth tiene que usarse dentro de <AuthProvider>');
  return value;
}
