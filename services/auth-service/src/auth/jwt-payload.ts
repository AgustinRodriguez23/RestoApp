import { Role } from '../users/role.enum';

/** Contenido del JWT. Los demás servicios y el BFF van a leer exactamente estos campos. */
export interface JwtPayload {
  sub: string; // id del usuario
  email: string;
  role: Role;
}
