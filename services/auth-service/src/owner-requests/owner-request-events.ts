/**
 * Eventos de las solicitudes para ser dueño. El `type` es la routing key en RabbitMQ.
 *
 *  auth ──owner-request.approved─▶ notifications (aviso "ya sos dueño")
 *  auth ──owner-request.rejected─▶ notifications (aviso con el motivo)
 *
 * Llevan lo necesario para armar el aviso: así quien los consume no tiene que llamar a auth-service.
 */
export const OwnerRequestEvents = {
  APPROVED: 'owner-request.approved',
  REJECTED: 'owner-request.rejected',
} as const;

export interface OwnerRequestReviewedData {
  requestId: string;
  /** A quién se le avisa: el que envió la solicitud. */
  userId: string;
  restaurantName: string;
  /** Solo en el rechazo. */
  reason?: string;
}
