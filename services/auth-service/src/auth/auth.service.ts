import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { QueryFailedError } from 'typeorm';
import { Role } from '../users/role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './jwt-payload';

const BCRYPT_ROUNDS = 10;

/**
 * Hash con el mismo costo que los reales, para comparar contra algo cuando el email no existe.
 * Sin esto el login de un email desconocido se saltea el bcrypt (lo más caro del pedido) y responde bastante antes:
 * midiendo tiempos se sabría quién está registrado.
 */
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', BCRYPT_ROUNDS);

/** Código de PostgreSQL para "se violó una restricción única" (el email de users). */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    // El registro es público: si cualquiera pudiera pedir el rol de dueño, el rol no protegería nada.
    // Se habilita solo en desarrollo y en el e2e (ALLOW_OWNER_SELF_REGISTER=true).
    if (dto.role === Role.RESTAURANT_OWNER && this.config.get<string>('ALLOW_OWNER_SELF_REGISTER') !== 'true') {
      throw new ForbiddenException('El alta de dueños de restaurante no está habilitada');
    }

    const email = dto.email.toLowerCase();

    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Ya existe un usuario con ese email');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    // Dos registros simultáneos con el mismo email pasan los dos el chequeo de arriba; el índice único
    // deja entrar a uno solo y el otro tiene que recibir el mismo 409, no un 500.
    const user = await this.users
      .create({ email, name: dto.name, passwordHash, role: dto.role ?? Role.CUSTOMER })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException('Ya existe un usuario con ese email');
        throw error;
      });

    return this.buildResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.users.findByEmailWithPassword(dto.email.toLowerCase());

    // Mismo mensaje y mismo tiempo si el usuario no existe o la contraseña es incorrecta,
    // para no revelar qué emails están registrados.
    const valid = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return this.buildResponse(user);
  }

  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('El usuario ya no existe');
    }
    return this.toUserResponse(user);
  }

  private async buildResponse(user: User): Promise<AuthResponseDto> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toUserResponse(user),
    };
  }

  private toUserResponse(user: User): UserResponseDto {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
