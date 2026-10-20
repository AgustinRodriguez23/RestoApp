import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationDraft } from './notification-templates';
import { Notification, NotificationDocument } from './schemas/notification.schema';

const DUPLICATE_KEY = 11000;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectModel(Notification.name) private readonly model: Model<Notification>) {}

  /**
   * Guarda la notificación de un evento. Es idempotente: el índice único de `eventId` hace que un evento repetido
   * no cree otra notificación (devuelve 'duplicate' en vez de fallar). No hay "chequear y después insertar":
   * se inserta directo y es Mongo quien decide, así que dos entregas simultáneas tampoco duplican.
   */
  async createFromEvent(eventId: string, draft: NotificationDraft): Promise<'created' | 'duplicate'> {
    try {
      await this.model.create({ ...draft, eventId });
      return 'created';
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) return 'duplicate';
      throw error;
    }
  }

  async list(userId: string, query: ListNotificationsQueryDto) {
    const { page = 1, limit = 20, unread } = query;
    const filter = { userId, ...(unread ? { read: false } : {}) };

    const [data, total, unreadCount] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1, _id: -1 }) // _id desempata las que se crearon en el mismo milisegundo
        .skip((page - 1) * limit)
        .limit(limit),
      this.model.countDocuments(filter),
      this.unreadCount(userId),
    ]);
    return { data, page, limit, total, totalPages: Math.ceil(total / limit), unreadCount };
  }

  unreadCount(userId: string): Promise<number> {
    return this.model.countDocuments({ userId, read: false });
  }

  /**
   * Marca una como leída. Se busca por id Y por dueño: la de otra persona responde 404, igual que una inexistente,
   * para no revelar que existe. Marcar una ya leída no hace nada (conserva la fecha original).
   */
  async markRead(userId: string, id: string): Promise<NotificationDocument> {
    const notification = isValidObjectId(id) ? await this.model.findOne({ _id: id, userId }) : null;
    if (!notification) throw new NotFoundException('Notificación no encontrada');

    if (!notification.read) {
      notification.read = true;
      notification.readAt = new Date();
      await notification.save();
    }
    return notification;
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.model.updateMany({ userId, read: false }, { $set: { read: true, readAt: new Date() } });
    return { updated: result.modifiedCount };
  }
}
