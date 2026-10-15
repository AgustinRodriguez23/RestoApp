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
  menu: MenuItem[] | null;
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

export interface CreateReservationInput {
  restaurantId: string;
  partySize: number;
  startsAt: string;
  notes?: string;
}
