export enum Role {
  CUSTOMER = 'CUSTOMER',
  RESTAURANT_OWNER = 'RESTAURANT_OWNER',
  // Revisa las solicitudes para ser dueño. Nunca se obtiene desde la app: se asigna a mano en la base (docs/OPERACION.md).
  ADMIN = 'ADMIN',
}
