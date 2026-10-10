import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from './role.enum';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email } });
  }

  /** Igual que findByEmail pero incluye el hash (solo para validar el login). */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.repo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  async create(data: {
    email: string;
    name: string;
    passwordHash: string;
    role: Role;
  }): Promise<User> {
    const user = await this.repo.save(this.repo.create(data));
    // El hash no se devuelve hacia afuera
    const { passwordHash: _omit, ...safe } = user;
    return safe as User;
  }
}
