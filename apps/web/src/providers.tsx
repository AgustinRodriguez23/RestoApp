import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Provider as ReduxProvider } from 'react-redux';
import { ApiError } from './lib/api';
import { AuthProvider } from './auth/AuthContext';
import { createStore, type AppStore } from './store';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Un error 4xx (no existe, no tenés permiso) no mejora reintentando; uno de red o 5xx sí, un par de veces
        retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
        staleTime: 10_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false }, // un POST nunca se reintenta solo: un cobro duplicado es peor que un error
    },
  });
}

export function AppProviders({ children, store, queryClient }: { children: ReactNode; store?: AppStore; queryClient?: QueryClient }) {
  const [redux] = useState(() => store ?? createStore());
  const [query] = useState(() => queryClient ?? createQueryClient());
  return (
    <ReduxProvider store={redux}>
      <QueryClientProvider client={query}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ReduxProvider>
  );
}


