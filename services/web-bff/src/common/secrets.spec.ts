import { ConfigService } from '@nestjs/config';
import { MIN_SECRET_LENGTH, requireSecret } from './secrets';

describe('requireSecret', () => {
  const config = (env: Record<string, string>) => new ConfigService(env);
  const strong = 'a'.repeat(MIN_SECRET_LENGTH);

  it('falla si el secreto no está definido, en cualquier entorno', () => {
    expect(() => requireSecret(config({}), 'JWT_SECRET')).toThrow('JWT_SECRET');
  });

  it('fuera de producción acepta cualquier valor', () => {
    expect(requireSecret(config({ JWT_SECRET: 'corto' }), 'JWT_SECRET')).toBe('corto');
  });

  it('en producción acepta un secreto de al menos 32 caracteres', () => {
    expect(requireSecret(config({ NODE_ENV: 'production', JWT_SECRET: strong }), 'JWT_SECRET')).toBe(strong);
  });

  it('en producción rechaza uno corto', () => {
    expect(() => requireSecret(config({ NODE_ENV: 'production', JWT_SECRET: strong.slice(1) }), 'JWT_SECRET')).toThrow(
      'demasiado corto',
    );
  });

  it('en producción rechaza el valor de ejemplo del .env.example aunque sea largo', () => {
    const env = { NODE_ENV: 'production', JWT_SECRET: 'cambiame-por-un-secreto-largo-y-aleatorio' };
    expect(() => requireSecret(config(env), 'JWT_SECRET')).toThrow('valor de ejemplo');
  });
});
