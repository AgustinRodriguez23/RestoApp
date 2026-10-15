/**
 * Cliente HTTP del BFF. Todo el frontend habla con la API a través de acá, así que los errores
 * tienen una sola forma (ApiError) y el token se agrega en un solo lugar.
 */
const BASE_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

/** Error de la API ya "traducido" para mostrar: nunca se le muestra al usuario un objeto crudo. */
export class ApiError extends Error {
  constructor(
    /** Código HTTP. 0 = no hubo respuesta (sin red, BFF caído, timeout del navegador). */
    readonly status: number,
    message: string,
    /** Id de seguimiento del pedido (header x-correlation-id): sirve para buscarlo en Grafana. */
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  replayed: boolean;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

let tokenProvider: () => string | null = () => null;
let unauthorizedHandler: () => void = () => undefined;

/** AuthProvider registra acá cómo leer el token y qué hacer si el servidor dice que ya no vale. */
export function configureApi(config: { getToken: () => string | null; onUnauthorized: () => void }) {
  tokenProvider = config.getToken;
  unauthorizedHandler = config.onUnauthorized;
}

function messageFrom(body: unknown, status: number): string {
  const raw = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(raw) && raw.length > 0) return raw.join('. ');
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (status >= 500) return 'Algo falló de nuestro lado. Probá de nuevo en unos segundos.';
  return 'No pudimos completar la acción.';
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'No pudimos conectar con el servidor. Revisá tu conexión y probá de nuevo.');
  }

  const correlationId = response.headers.get('x-correlation-id') ?? undefined;
  let body: unknown = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    // Token vencido o inválido: se cierra la sesión (salvo en el login mismo, donde 401 = clave incorrecta)
    if (response.status === 401 && token) unauthorizedHandler();
    throw new ApiError(response.status, messageFrom(body, response.status), correlationId);
  }
  return { data: body as T, status: response.status, replayed: response.headers.get('idempotent-replayed') === 'true' };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { query, signal }).then((r) => r.data),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, headers }),
};
