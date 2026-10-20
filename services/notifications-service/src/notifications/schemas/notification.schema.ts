import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { applyJsonTransform } from '../../common/mongoose-json';

export const NOTIFICATION_TYPES = [
  'RESERVATION_CONFIRMED',
  'RESERVATION_CANCELLED_BY_RESTAURANT',
  'RESERVATION_PAYMENT_FAILED',
  'RESERVATION_EXPIRED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Cuánto se conserva una notificación. Una bandeja no es un historial: pasado este plazo Mongo la borra sola. */
export const NOTIFICATION_TTL_DAYS = 90;

@Schema({ timestamps: true })
export class Notification {
  /** Id del usuario (de auth-service) al que se le avisa. Referencia lógica, no una FK. */
  @Prop({ required: true })
  userId: string;

  /**
   * Id del evento que la originó. El índice ÚNICO de este campo es la idempotencia: RabbitMQ entrega "al menos una vez",
   * así que un mismo evento puede llegar dos veces, pero solo puede crear una notificación. Cada evento avisa a una sola persona.
   */
  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true, enum: NOTIFICATION_TYPES })
  type: NotificationType;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  body: string;

  @Prop({ required: true })
  reservationId: string;

  @Prop({ required: true })
  restaurantId: string;

  @Prop({ required: true, default: false })
  read: boolean;

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  createdAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
applyJsonTransform(NotificationSchema);

NotificationSchema.index({ eventId: 1 }, { unique: true });
// La consulta de siempre: "las mías, de la más nueva a la más vieja" (con o sin filtro de no leídas)
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, read: 1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_DAYS * 24 * 3600 });
