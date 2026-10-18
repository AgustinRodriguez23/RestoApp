import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import type { CreateReservationInput, MenuCategory, MenuItemInput, OwnerReservation, RestaurantInput, Page, Payment, Reservation, ReservationStatus, Restaurant, RestaurantOverview } from './types';

/**
 * Todo el estado que vive en el servidor pasa por React Query: caché, reintentos, "cargando" y
 * "error" salen de acá y las pantallas no los reimplementan. Las claves están en un solo lugar para
 * poder invalidar con precisión (por ejemplo, al cancelar se refrescan las reservas pero no los restaurantes).
 */
export const keys = {
  restaurants: (params: object) => ['restaurants', params] as const,
  overview: (id: string, date: string, partySize: number) => ['overview', id, date, partySize] as const,
  reservations: (params: object) => ['reservations', 'list', params] as const,
  reservation: (id: string) => ['reservations', 'detail', id] as const,
};

export function useRestaurants(params: { search: string; cuisine: string; page: number }) {
  return useQuery({
    queryKey: keys.restaurants(params),
    queryFn: ({ signal }) =>
      api.get<Page<Restaurant>>('/restaurants', { search: params.search, cuisine: params.cuisine, page: params.page, limit: 9 }, signal),
    placeholderData: keepPreviousData, // al cambiar de página se ve la anterior hasta que llega la nueva
  });
}

export function useRestaurantOverview(id: string, date: string, partySize: number) {
  return useQuery({
    queryKey: keys.overview(id, date, partySize),
    queryFn: ({ signal }) => api.get<RestaurantOverview>(`/restaurants/${id}/overview`, { date, partySize }, signal),
    // Los horarios libres cambian cuando otros reservan: si el usuario vuelve a la pestaña, se refrescan
    enabled: id !== '' && date !== '',
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useMyReservations(status: ReservationStatus | '') {
  return useQuery({
    queryKey: keys.reservations({ status }),
    queryFn: ({ signal }) => api.get<Page<Reservation>>('/reservations/mine', { status, limit: 50 }, signal),
    placeholderData: keepPreviousData,
  });
}

/** Estados en los que el resultado todavía puede cambiar solo (por un evento o un webhook): se consulta cada tanto. */
export function isSettling(reservation: Reservation | undefined): boolean {
  if (!reservation || reservation.status !== 'PENDING_PAYMENT') return false;
  // PROCESSING: la pasarela avisará por webhook. SUCCEEDED/FAILED con la reserva todavía pendiente:
  // el evento que la confirma (o la cancela) está en camino.
  const status = reservation.payment?.status;
  return status === 'PROCESSING' || status === 'SUCCEEDED' || status === 'FAILED';
}

export function useReservation(id: string) {
  return useQuery({
    queryKey: keys.reservation(id),
    queryFn: ({ signal }) => api.get<Reservation>(`/reservations/${id}`, undefined, signal),
    refetchInterval: (query) => (isSettling(query.state.data) ? 2000 : false),
  });
}

export function useCreateReservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReservationInput) => api.post<Reservation>('/reservations', input).then((r) => r.data),
    onSuccess: (reservation) => {
      queryClient.setQueryData(keys.reservation(reservation.id), reservation);
      // La mesa ahora está retenida: los horarios libres y mis reservas cambiaron
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations', 'list'] });
    },
  });
}

export function useCancelReservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Reservation>(`/reservations/${id}/cancel`).then((r) => r.data),
    onSuccess: (reservation) => {
      queryClient.setQueryData(keys.reservation(reservation.id), reservation);
      void queryClient.invalidateQueries({ queryKey: ['reservations', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      // La devolución de la seña llega por evento unos instantes después: se vuelve a mirar
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['reservations'] }), 2500);
    },
  });
}

export interface PayInput {
  reservationId: string;
  token: string;
  idempotencyKey: string;
}

export interface PayResult {
  payment: Payment;
  /** true = la pasarela todavía procesa (HTTP 202): el resultado llega después */
  processing: boolean;
  replayed: boolean;
}

export function usePayReservation() {
  const queryClient = useQueryClient();
  return useMutation<PayResult, ApiError, PayInput>({
    mutationFn: async ({ reservationId, token, idempotencyKey }) => {
      const response = await api.post<Payment>(`/reservations/${reservationId}/pay`, { token }, { 'Idempotency-Key': idempotencyKey });
      return { payment: response.data, processing: response.status === 202, replayed: response.replayed };
    },
    // Éxito o rechazo, la reserva cambió (se confirma o se cancela por evento, unos instantes después)
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: keys.reservation(input.reservationId) });
      void queryClient.invalidateQueries({ queryKey: ['reservations', 'list'] });
    },
  });
}

/** Panel del dueño */
export function useMyRestaurants() {
  return useQuery({
    queryKey: ['owner', 'restaurants'] as const,
    queryFn: ({ signal }) => api.get<Restaurant[]>('/owner/restaurants', undefined, signal),
  });
}

export interface OwnerReservationsParams {
  restaurantId: string;
  date: string;
  status: ReservationStatus | '';
  page: number;
}

export function useOwnerReservations(params: OwnerReservationsParams) {
  return useQuery({
    queryKey: ['owner', 'reservations', params] as const,
    queryFn: ({ signal }) =>
      api.get<Page<OwnerReservation>>(
        `/owner/restaurants/${params.restaurantId}/reservations`,
        { date: params.date, status: params.status, page: params.page, limit: 20 },
        signal,
      ),
    enabled: params.restaurantId !== '',
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
  });
}

/** Marcar "asistió" (COMPLETED) o "no vino" (NO_SHOW) y cancelar: las dos acciones cambian la lista del dueño. */
export function useSetReservationStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: 'COMPLETED' | 'NO_SHOW' }) =>
      api.patch<OwnerReservation>(`/owner/reservations/${input.id}/status`, { status: input.status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['owner', 'reservations'] }),
  });
}

export function useOwnerCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<OwnerReservation>(`/reservations/${id}/cancel`).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['owner', 'reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] }); // la mesa vuelve a estar libre
    },
  });
}

/** Alta, edición y baja de restaurantes: cambian mi lista, el listado público y el detalle (que ve cualquier cliente). */
function useRestaurantsRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['owner'] });
    void queryClient.invalidateQueries({ queryKey: ['restaurants'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };
}

export function useCreateRestaurant() {
  const refresh = useRestaurantsRefresh();
  return useMutation({
    mutationFn: (input: RestaurantInput) => api.post<Restaurant>('/owner/restaurants', input).then((r) => r.data),
    onSuccess: refresh,
  });
}

export function useUpdateRestaurant(id: string) {
  const refresh = useRestaurantsRefresh();
  return useMutation({
    mutationFn: (input: Partial<RestaurantInput>) => api.patch<Restaurant>(`/owner/restaurants/${id}`, input),
    onSuccess: refresh,
  });
}

export function useDeleteRestaurant() {
  const refresh = useRestaurantsRefresh();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/owner/restaurants/${id}`),
    onSuccess: refresh,
  });
}

/** Carta del dueño: incluye los platos pausados (la pública no los muestra). */
export function useOwnerMenu(restaurantId: string) {
  return useQuery({
    queryKey: ['owner', 'menu', restaurantId] as const,
    queryFn: ({ signal }) => api.get<MenuCategory[]>(`/owner/restaurants/${restaurantId}/menu`, undefined, signal),
    enabled: restaurantId !== '',
  });
}

/** Cualquier cambio en la carta refresca la del dueño y la pública (el detalle del restaurante). */
function useMenuRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['owner', 'menu'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };
}

export function useSaveMenuItem(restaurantId: string) {
  const refresh = useMenuRefresh();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId?: string; input: MenuItemInput }) =>
      itemId
        ? api.patch(`/owner/restaurants/${restaurantId}/menu-items/${itemId}`, input)
        : api.post(`/owner/restaurants/${restaurantId}/menu-items`, input).then((r) => r.data),
    onSuccess: refresh,
  });
}

export function useSetMenuItemAvailable(restaurantId: string) {
  const refresh = useMenuRefresh();
  return useMutation({
    mutationFn: ({ itemId, available }: { itemId: string; available: boolean }) =>
      api.patch(`/owner/restaurants/${restaurantId}/menu-items/${itemId}`, { available }),
    onSuccess: refresh,
  });
}

export function useDeleteMenuItem(restaurantId: string) {
  const refresh = useMenuRefresh();
  return useMutation({
    mutationFn: (itemId: string) => api.delete(`/owner/restaurants/${restaurantId}/menu-items/${itemId}`),
    onSuccess: refresh,
  });
}
