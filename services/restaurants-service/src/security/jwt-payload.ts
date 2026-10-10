import { Role } from './role.enum';

/** Contenido del JWT que firma auth-service. */
export interface JwtPayload {
  sub: string; // id del usuario
  email: string;
  role: Role;
}
