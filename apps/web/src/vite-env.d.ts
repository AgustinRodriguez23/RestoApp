/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Base de la API. Por defecto "/api" (proxy de Vite o de nginx hacia el BFF). */
  readonly VITE_API_URL?: string;
}
