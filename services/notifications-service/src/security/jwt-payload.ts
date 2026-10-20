import { Role } from './role.enum';

/** Contenido del JWT que firma auth-service. */
export interface JwtPayload {
  sub: string; // id del usuario
  email: string;
  /** Nombre del usuario. Opcional: los tokens emitidos antes de este campo no lo traen. */
  name?: string;
  role: Role;
}
