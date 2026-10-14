/**
 * Copia de los roles de auth-service. En microservicios cada servicio es independiente,
 * así que por ahora el contrato (los valores del enum) se duplica.
 * Con tres servicios ya conviene moverlo a un paquete compartido del monorepo.
 */
export enum Role {
  CUSTOMER = 'CUSTOMER',
  RESTAURANT_OWNER = 'RESTAURANT_OWNER',
}
