import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { createLogger, JsonLogger } from './json-logger';
import { runWithContext } from './request-context';

const NOW = new Date('2026-10-13T12:00:00.000Z');

const make = (options: Partial<ConstructorParameters<typeof JsonLogger>[0]> = {}) => {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: 'test-svc', write: (l) => lines.push(l), now: () => NOW, ...options });
  return { logger, lines, last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown> };
};

describe('JsonLogger', () => {
  it('escribe una línea JSON con timestamp, nivel, servicio y mensaje', () => {
    const { logger, lines, last } = make();

    logger.log('hola mundo');

    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ timestamp: '2026-10-13T12:00:00.000Z', level: 'info', service: 'test-svc', message: 'hola mundo' });
  });

  it('toma el context (nombre de la clase) que Nest pasa como último parámetro', () => {
    const { logger, last } = make();

    logger.warn('cuidado', 'MiClase');

    expect(last()).toMatchObject({ level: 'warn', context: 'MiClase', message: 'cuidado' });
  });

  it('en error(), distingue el stack del context', () => {
    const { logger, last } = make();

    logger.error('falló', 'Error: x\n    at foo (file.ts:1:1)', 'MiClase');
    expect(last()).toMatchObject({ level: 'error', context: 'MiClase', stack: expect.stringContaining('at foo') });

    logger.error('falló', 'SoloContexto');
    expect(last()).toMatchObject({ context: 'SoloContexto' });
    expect(last().stack).toBeUndefined();
  });

  it('un objeto con "message" aporta campos estructurados', () => {
    const { logger, last } = make();

    logger.log({ message: 'request completed', method: 'GET', status: 200, durationMs: 12.5 });

    expect(last()).toMatchObject({ message: 'request completed', method: 'GET', status: 200, durationMs: 12.5 });
  });

  it('los campos del usuario no pueden pisar los reservados', () => {
    const { logger, last } = make();

    logger.log({ message: 'real', level: 'fatal', service: 'otro', correlationId: 'falso', timestamp: 'ayer' });

    expect(last()).toMatchObject({ level: 'info', service: 'test-svc', message: 'real', timestamp: NOW.toISOString() });
    expect(last().correlationId).toBeUndefined();
  });

  it('un Error se loguea con su mensaje y su stack', () => {
    const { logger, last } = make();

    logger.error(new Error('se rompió'));

    expect(last()).toMatchObject({ level: 'error', message: 'se rompió', stack: expect.stringContaining('Error: se rompió') });
  });

  describe('contexto de la request', () => {
    it('agrega correlationId y userId automáticamente', () => {
      const { logger, last } = make();

      runWithContext({ correlationId: 'corr-12345678', userId: 'user-1' }, () => logger.log('dentro de una request'));

      expect(last()).toMatchObject({ correlationId: 'corr-12345678', userId: 'user-1' });
    });

    it('fuera de una request no inventa ids', () => {
      const { logger, last } = make();

      logger.log('arranque');

      expect(last()).not.toHaveProperty('correlationId');
      expect(last()).not.toHaveProperty('userId');
    });
  });

  describe('datos sensibles', () => {
    it('redacta contraseñas, tokens y headers de autorización, aunque estén anidados', () => {
      const { logger, lines } = make();

      logger.log({
        message: 'x',
        password: 'Password123',
        accessToken: 'eyJhbGciOi.secreto',
        headers: { Authorization: 'Bearer eyJhbGciOi.secreto', accept: 'json' },
        nested: { deep: { client_secret: 'abc' }, list: [{ apiKey: 'k' }] },
      });

      expect(lines[0]).not.toMatch(/Password123|eyJhbGciOi|secreto|"abc"|"k"/);
      expect(JSON.parse(lines[0])).toMatchObject({ password: '[REDACTED]', headers: { Authorization: '[REDACTED]', accept: 'json' } });
    });
  });

  describe('robustez', () => {
    it('no explota con referencias circulares ni BigInt', () => {
      const { logger, last } = make();
      const circular: Record<string, unknown> = { name: 'a' };
      circular.self = circular;

      expect(() => logger.log({ message: 'x', circular, big: BigInt(10) })).not.toThrow();
      expect(last()).toMatchObject({ big: '10' });
    });

    it('limita la profundidad de objetos enormes', () => {
      const { logger, lines } = make();
      let deep: Record<string, unknown> = { fin: true };
      for (let i = 0; i < 10; i++) deep = { child: deep };

      logger.log({ message: 'x', deep });

      expect(lines[0]).toContain('[Object]');
    });
  });

  describe('niveles', () => {
    it('descarta lo que está por debajo del nivel configurado', () => {
      const { logger, lines } = make({ level: 'warn' });

      logger.debug('d');
      logger.verbose('v');
      logger.log('i');
      logger.warn('w');
      logger.error('e');
      logger.fatal('f');

      expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error', 'fatal']);
    });

    it('con nivel debug incluye todo; verbose cuenta como debug', () => {
      const { logger, lines } = make({ level: 'debug' });

      logger.verbose('v');
      logger.debug('d');

      expect(lines).toHaveLength(2);
    });
  });

  it('setLogLevels (lo usa Nest) ajusta el nivel mínimo', () => {
    const { logger, lines } = make();

    logger.setLogLevels(['error', 'fatal']);
    logger.warn('no');
    logger.error('si');

    expect(lines).toHaveLength(1);
  });

  describe('formato pretty (para leer en la terminal)', () => {
    it('es legible y no es JSON', () => {
      const { logger, lines } = make({ format: 'pretty' });

      runWithContext({ correlationId: 'abcdef12-3456', userId: 'u1' }, () => logger.log({ message: 'listo', status: 200 }, 'HTTP'));

      expect(lines[0]).toMatch(/12:00:00\.000 INFO {2}\[test-svc\/HTTP\] listo/);
      expect(lines[0]).toContain('"status":200');
      expect(lines[0]).toContain('cid=abcdef12');
      expect(lines[0]).toContain('user=u1');
      expect(() => JSON.parse(lines[0])).toThrow();
    });
  });

  describe('archivo de log (para servicios fuera de Docker)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'logger-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('además de stdout agrega cada línea JSON al archivo, creando la carpeta', () => {
      const file = join(dir, 'sub', 'svc.log');
      const { logger } = make({ file, format: 'pretty' });

      logger.log('uno');
      logger.warn('dos');

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.message)).toEqual(['uno', 'dos']); // aunque la terminal sea pretty, el archivo es JSON
    });

    it('si el archivo no se puede escribir, el servicio sigue funcionando', () => {
      const { logger, lines } = make({ file: join(dir, 'ok.log') });
      rmSync(dir, { recursive: true, force: true }); // ahora la carpeta no existe

      expect(() => logger.log('sigo vivo')).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(existsSync(join(dir, 'ok.log'))).toBe(false);
    });
  });

  describe('createLogger (variables de entorno)', () => {
    const capture = (env: NodeJS.ProcessEnv) => {
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const logger = createLogger('svc', env);
      logger.debug('d');
      logger.log('i');
      const out = spy.mock.calls.map(([c]) => String(c));
      spy.mockRestore();
      return out;
    };

    it('por defecto: JSON, nivel info', () => {
      const out = capture({});

      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]).message).toBe('i');
    });

    it('LOG_LEVEL=debug y LOG_FORMAT=pretty', () => {
      const out = capture({ LOG_LEVEL: 'debug', LOG_FORMAT: 'pretty' });

      expect(out).toHaveLength(2);
      expect(out[0]).toMatch(/DEBUG/);
    });

    it('LOG_DIR agrega un archivo <servicio>.log con las líneas JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'logdir-'));
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      createLogger('svc-x', { LOG_DIR: dir }).log('hola');

      jest.restoreAllMocks();
      expect(JSON.parse(readFileSync(join(dir, 'svc-x.log'), 'utf8')).message).toBe('hola');
      rmSync(dir, { recursive: true, force: true });
    });

    it('un LOG_LEVEL inválido cae en info', () => {
      expect(capture({ LOG_LEVEL: 'ruidoso' })).toHaveLength(1);
    });
  });

  it('funciona como logger global de Nest (Logger.overrideLogger)', () => {
    const { logger, lines } = make();
    Logger.overrideLogger(logger);

    new Logger('MiServicio').log('desde Nest');
    new Logger('MiServicio').error('mal', 'trace\n    at x (y.ts:1:1)');

    Logger.overrideLogger(false);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', context: 'MiServicio', message: 'desde Nest' });
    expect(JSON.parse(lines[1])).toMatchObject({ level: 'error', context: 'MiServicio', stack: expect.stringContaining('at x') });
  });
});
