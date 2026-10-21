import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Role } from '../users/role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let users: jest.Mocked<
    Pick<UsersService, 'findByEmail' | 'findByEmailWithPassword' | 'findById' | 'create'>
  >;
  let jwt: { signAsync: jest.Mock };
  let config: { get: jest.Mock };

  const baseUser = {
    id: 'user-1',
    email: 'ana@example.com',
    name: 'Ana',
    role: Role.CUSTOMER,
  } as User;

  beforeEach(async () => {
    users = {
      findByEmail: jest.fn(),
      findByEmailWithPassword: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-token') };
    config = { get: jest.fn().mockReturnValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('crea el usuario con la contraseña hasheada y devuelve token', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(baseUser);

      const result = await service.register({
        email: 'ANA@example.com',
        name: 'Ana',
        password: 'Password123',
      });

      const created = users.create.mock.calls[0][0];
      expect(created.email).toBe('ana@example.com'); // normalizado a minúsculas
      expect(created.role).toBe(Role.CUSTOMER); // rol por defecto
      expect(created.passwordHash).not.toBe('Password123');
      expect(await bcrypt.compare('Password123', created.passwordHash)).toBe(true);
      expect(result.accessToken).toBe('signed-token');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'ana@example.com',
        name: 'Ana',
        role: Role.CUSTOMER,
      });
    });

    it('lanza 409 si el email ya existe', async () => {
      users.findByEmail.mockResolvedValue(baseUser);

      await expect(
        service.register({ email: 'ana@example.com', name: 'Ana', password: 'Password123' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });

    const ownerDto = { email: 'dueno@example.com', name: 'Dueño', password: 'Password123', role: Role.RESTAURANT_OWNER };

    it('rechaza con 403 el alta de un dueño si ALLOW_OWNER_SELF_REGISTER no está activado', async () => {
      await expect(service.register(ownerDto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('con ALLOW_OWNER_SELF_REGISTER=true respeta el rol de dueño', async () => {
      config.get.mockReturnValue('true');
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue({ ...baseUser, role: Role.RESTAURANT_OWNER } as User);

      await service.register(ownerDto);

      expect(users.create.mock.calls[0][0].role).toBe(Role.RESTAURANT_OWNER);
    });

    it('pedir explícitamente CUSTOMER siempre se puede', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(baseUser);

      await service.register({ ...ownerDto, role: Role.CUSTOMER });

      expect(users.create.mock.calls[0][0].role).toBe(Role.CUSTOMER);
    });
  });

  describe('login', () => {
    it('devuelve token si las credenciales son correctas', async () => {
      const passwordHash = await bcrypt.hash('Password123', 4);
      users.findByEmailWithPassword.mockResolvedValue({ ...baseUser, passwordHash } as User);

      const result = await service.login({ email: 'ana@example.com', password: 'Password123' });

      expect(result.accessToken).toBe('signed-token');
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        email: 'ana@example.com',
        name: baseUser.name,
        role: Role.CUSTOMER,
      });
    });

    it('lanza 401 si la contraseña es incorrecta', async () => {
      const passwordHash = await bcrypt.hash('Password123', 4);
      users.findByEmailWithPassword.mockResolvedValue({ ...baseUser, passwordHash } as User);

      await expect(
        service.login({ email: 'ana@example.com', password: 'otra-clave' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('lanza 401 con el mismo mensaje si el usuario no existe', async () => {
      users.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nadie@example.com', password: 'Password123' }),
      ).rejects.toThrow('Credenciales inválidas');
    });
  });

  describe('getProfile', () => {
    it('devuelve los datos públicos del usuario', async () => {
      users.findById.mockResolvedValue(baseUser);
      await expect(service.getProfile('user-1')).resolves.toEqual({
        id: 'user-1',
        email: 'ana@example.com',
        name: 'Ana',
        role: Role.CUSTOMER,
      });
    });

    it('lanza 401 si el usuario ya no existe', async () => {
      users.findById.mockResolvedValue(null);
      await expect(service.getProfile('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
