import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../auth/auth.service';
import { OutboxService } from '../messaging/outbox.service';
import { Role } from '../users/role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import {
  CreateOwnerRequestDto,
  ListOwnerRequestsQueryDto,
  OwnerRequestPageDto,
  OwnerRequestResponseDto,
} from './dto/owner-request.dto';
import { OwnerRequest, OwnerRequestStatus } from './owner-request.entity';
import { OwnerRequestEvents, OwnerRequestReviewedData } from './owner-request-events';

@Injectable()
export class OwnerRequestsService {
  constructor(
    @InjectRepository(OwnerRequest) private readonly repo: Repository<OwnerRequest>,
    private readonly users: UsersService,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async create(userId: string, dto: CreateOwnerRequestDto): Promise<OwnerRequestResponseDto> {
    // El rol se lee de la base y no del token: recién aprobado, el token todavía puede decir CUSTOMER
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('El usuario ya no existe');
    if (user.role !== Role.CUSTOMER) {
      throw new ForbiddenException('Solo una cuenta de cliente puede pedir ser dueño');
    }

    const request = await this.repo
      .save(this.repo.create({ userId, ...dto, message: dto.message || null }))
      .catch((error: unknown) => {
        // El índice único parcial: ya hay una pendiente (o llegaron dos envíos a la vez y este perdió)
        if (isUniqueViolation(error)) throw new ConflictException('Ya tenés una solicitud pendiente');
        throw error;
      });
    return toResponse(request);
  }

  /** La última que envió el usuario: es la que dice en qué estado está. */
  async findMine(userId: string): Promise<OwnerRequestResponseDto> {
    const request = await this.repo.findOne({ where: { userId }, order: { createdAt: 'DESC' } });
    if (!request) throw new NotFoundException('Todavía no enviaste una solicitud');
    return toResponse(request);
  }

  async list(query: ListOwnerRequestsQueryDto): Promise<OwnerRequestPageDto> {
    const { page = 1, limit = 10, status = OwnerRequestStatus.PENDING } = query;
    const [data, total] = await this.repo.findAndCount({
      where: { status },
      relations: { user: true },
      // Las pendientes, de la más vieja a la más nueva (se atienden por orden de llegada); las revisadas, al revés
      order: { createdAt: status === OwnerRequestStatus.PENDING ? 'ASC' : 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: data.map(toResponse), page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Aprueba y convierte al usuario en dueño, en una sola transacción: o pasan las dos cosas o ninguna.
   * Por eso las solicitudes viven en auth-service, al lado de users, y no en un servicio aparte.
   * El aviso al usuario sale por el outbox, en la misma transacción: si algo se deshace, el aviso también.
   */
  async approve(id: string, adminId: string): Promise<OwnerRequestResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.review(manager, id, adminId, { status: OwnerRequestStatus.APPROVED });

      const promoted = await manager
        .getRepository(User)
        .update({ id: request.userId, role: Role.CUSTOMER }, { role: Role.RESTAURANT_OWNER });
      if (!promoted.affected) {
        // Le cambiaron el rol a mano mientras tanto. Se deshace todo, la solicitud incluida.
        throw new ConflictException('El usuario ya no es una cuenta de cliente');
      }
      await this.outbox.enqueue<OwnerRequestReviewedData>(manager, OwnerRequestEvents.APPROVED, {
        requestId: request.id,
        userId: request.userId,
        restaurantName: request.restaurantName,
      });
      return toResponse(request);
    });
  }

  async reject(id: string, adminId: string, reason: string): Promise<OwnerRequestResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.review(manager, id, adminId, { status: OwnerRequestStatus.REJECTED, rejectionReason: reason });
      await this.outbox.enqueue<OwnerRequestReviewedData>(manager, OwnerRequestEvents.REJECTED, {
        requestId: request.id,
        userId: request.userId,
        restaurantName: request.restaurantName,
        reason,
      });
      return toResponse(request);
    });
  }

  /**
   * Cambia el estado solo si sigue pendiente (UPDATE ... WHERE status = 'PENDING'). Si dos admins la revisan a la vez,
   * la base deja pasar a uno y el otro recibe un 409: nunca se aprueba y se rechaza la misma solicitud.
   */
  private async review(
    manager: EntityManager,
    id: string,
    adminId: string,
    changes: Pick<OwnerRequest, 'status'> & Partial<Pick<OwnerRequest, 'rejectionReason'>>,
  ): Promise<OwnerRequest> {
    const repo = manager.getRepository(OwnerRequest);
    const result = await repo.update(
      { id, status: OwnerRequestStatus.PENDING },
      { ...changes, reviewedBy: adminId, reviewedAt: new Date() },
    );
    if (!result.affected) {
      if (!(await repo.exists({ where: { id } }))) throw new NotFoundException('No existe esa solicitud');
      throw new ConflictException('Esa solicitud ya fue revisada');
    }
    return repo.findOneByOrFail({ id });
  }
}

function toResponse(request: OwnerRequest): OwnerRequestResponseDto {
  return {
    id: request.id,
    status: request.status,
    restaurantName: request.restaurantName,
    address: request.address,
    phone: request.phone,
    message: request.message,
    rejectionReason: request.rejectionReason,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    ...(request.user && {
      applicant: { id: request.user.id, email: request.user.email, name: request.user.name },
    }),
  };
}
