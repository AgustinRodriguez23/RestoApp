/** Formas de las respuestas del BFF (lo que el frontend realmente usa). */
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'CUSTOMER' | 'RESTAURANT_OWNER';
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface OpeningHours {
  dayOfWeek: number;
  opens: string;
  closes: string;
}

export interface Restaurant {
  id: string;
  name: string;
  description?: string;
  cuisine: string;
  address: string;
  phone?: string;
  openingHours: OpeningHours[];
  tables: { number: number; capacity: number }[];
}

/** Lo que se manda para crear o modificar un restaurante. */
export interface RestaurantInput {
  name: string;
  description?: string;
  cuisine: string;
  address: string;
  phone?: string;
  openingHours: OpeningHours[];
  tables: { number: number; capacity: number }[];
}

/** Lo que se manda para crear o modificar un plato (el precio y las diferencias, en centavos). */
export interface MenuItemInput {
  category: string;
  name: string;
  description?: string;
  priceCents: number;
  allergens: string[];
  variants: { name: string; priceDeltaCents: number }[];
  available: boolean;
}

export interface MenuItem {
  id?: string;
  category: string;
  name: string;
  description?: string;
  priceCents: number;
  allergens: string[];
  variants: { name: string; priceDeltaCents: number }[];
  available: boolean;
}

/** Así devuelve la carta restaurants-service: agrupada por categoría (no una lista plana de platos). */
export interface MenuCategory {
  category: string;
  items: MenuItem[];
}

export interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
  availableTables: number;
}

export interface Availability {
  restaurantId: string;
  date: string;
  partySize: number;
  durationMinutes: number;
  timeZone: string;
  slots: AvailabilitySlot[];
}

export interface Warning {
  section: string;
  message: string;
}

export interface RestaurantOverview {
  restaurant: Restaurant;
  menu: MenuCategory[] | null;
  availability: Availability | null;
  warnings: Warning[];
}

export type ReservationStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'COMPLETED' | 'NO_SHOW';

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

export interface Payment {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  expiresAt: string;
  failureReason: string | null;
}

export interface Reservation {
  id: string;
  restaurantId: string;
  restaurant: { id: string; name: string } | null;
  tableNumber: number;
  partySize: number;
  startsAt: string;
  endsAt: string;
  status: ReservationStatus;
  depositCents: number;
  expiresAt: string | null;
  notes: string | null;
  payment: Payment | null;
}

/** Una reserva vista por el dueño del local: trae el nombre del cliente (null en reservas anteriores a este dato). */
export interface OwnerReservation {
  id: string;
  restaurantId: string;
  tableNumber: number;
  customerName: string | null;
  partySize: number;
  startsAt: string;
  endsAt: string;
  status: ReservationStatus;
  depositCents: number;
  notes: string | null;
}

/** Cuántas reservas hay en un día, por estado (los seis estados siempre están, en 0 si no hay). */
export interface DaySummary {
  date: string;
  total: number;
  byStatus: Record<ReservationStatus, number>;
}

export interface CreateReservationInput {
  restaurantId: string;
  partySize: number;
  startsAt: string;
  notes?: string;
}

export type NotificationType = 'RESERVATION_CONFIRMED' | 'RESERVATION_CANCELLED_BY_RESTAURANT' | 'RESERVATION_PAYMENT_FAILED' | 'RESERVATION_EXPIRED';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  reservationId: string;
  restaurantId: string;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** La lista trae además cuántas hay sin leer en total (no solo en esta página). */
export interface NotificationsPage extends Page<AppNotification> {
  unreadCount: number;
}
