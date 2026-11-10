import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Las cuentas de demo que puede haber: un dueño (el panel) y un cliente (reservar y pagar la seña). */
export const DEMO_ROLES = ['owner', 'customer'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

export interface DemoCredentials {
  email: string;
  password: string;
}

const VARS: Record<DemoRole, { email: string; password: string }> = {
  owner: { email: 'DEMO_OWNER_EMAIL', password: 'DEMO_OWNER_PASSWORD' },
  customer: { email: 'DEMO_CUSTOMER_EMAIL', password: 'DEMO_CUSTOMER_PASSWORD' },
};

/**
 * Credenciales de las cuentas de demo (los botones "Probar como dueño / cliente" del login).
 * Viven solo en el entorno del BFF: el front nunca las ve. Pide entrar con un rol y el BFF hace el login.
 * Una cuenta sin email o sin contraseña cuenta como no configurada: en desarrollo y en el CI no hay ninguna.
 */
@Injectable()
export class DemoAccounts {
  private readonly accounts: Partial<Record<DemoRole, DemoCredentials>> = {};

  constructor(config: ConfigService) {
    for (const role of DEMO_ROLES) {
      const email = config.get<string>(VARS[role].email)?.trim();
      const password = config.get<string>(VARS[role].password);
      if (email && password) this.accounts[role] = { email, password };
    }
  }

  /** Los roles con cuenta configurada, en orden fijo (dueño primero). */
  available(): DemoRole[] {
    return DEMO_ROLES.filter((role) => this.accounts[role] !== undefined);
  }

  credentials(role: DemoRole): DemoCredentials | undefined {
    return this.accounts[role];
  }
}
