import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LogLevel as NestLogLevel, LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

export interface JsonLoggerOptions {
  /** Nombre del servicio: aparece en cada línea y es lo que permite filtrar en Grafana. */
  service: string;
  level?: LogLevel;
  /** "json" (una línea JSON por evento, para máquinas) o "pretty" (legible, para mirar en la terminal). */
  format?: 'json' | 'pretty';
  /** Dónde se escribe cada línea. Por defecto stdout. */
  write?: (line: string) => void;
  /** Ruta de un archivo donde además se agregan las líneas (JSON) — para ver en Grafana un servicio que corre fuera de Docker. */
  file?: string;
  now?: () => Date;
}

// Claves cuyo valor jamás debe llegar a un log, aunque alguien lo agregue por error
const SENSITIVE_KEY = /authorization|password|passwd|secret|token|cookie|api[-_]?key/i;
const RESERVED = new Set(['timestamp', 'level', 'service', 'context', 'message', 'correlationId', 'userId']);
const MAX_DEPTH = 4;

/**
 * Logger de Nest que escribe UNA línea JSON por evento:
 *   {"timestamp":"...","level":"info","service":"web-bff","context":"HTTP","message":"...","correlationId":"..."}
 *
 * Por qué JSON: Loki/Grafana pueden filtrar por campo (`| json | correlationId="x"`) sin parsear texto.
 * El correlationId y el userId se toman solos del contexto de la request.
 */
export class JsonLogger implements LoggerService {
  private threshold: number;
  private readonly format: 'json' | 'pretty';
  private readonly writeOut: (line: string) => void;
  private readonly now: () => Date;
  private readonly appendToFile?: (line: string) => void;

  constructor(private readonly options: JsonLoggerOptions) {
    this.threshold = ORDER[options.level ?? 'info'];
    this.format = options.format ?? 'json';
    this.writeOut = options.write ?? ((line) => process.stdout.write(line + '\n'));
    this.now = options.now ?? (() => new Date());

    if (options.file) {
      const file = options.file;
      mkdirSync(dirname(file), { recursive: true });
      this.appendToFile = (line) => {
        try {
          appendFileSync(file, line + '\n');
        } catch {
          /* un archivo de log que falla nunca debe tumbar el servicio */
        }
      };
    }
  }

  // Nest llama a estos métodos; "log" de Nest es el nivel "info"
  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  /** Nest lo llama con app.useLogger([...]) / Logger.overrideLogger([...]): se queda con el nivel más bajo pedido. */
  setLogLevels(levels: NestLogLevel[]): void {
    const mapped = levels.map((l) => (l === 'log' ? 'info' : l === 'verbose' ? 'debug' : l) as LogLevel);
    if (mapped.length > 0) this.threshold = Math.min(...mapped.map((l) => ORDER[l]));
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (ORDER[level] < this.threshold) return;

    const { context, stack } = this.readParams(level, params);
    const { text, fields, errorStack } = this.readMessage(message);
    const store = getRequestContext();

    const entry: Record<string, unknown> = {
      timestamp: this.now().toISOString(),
      level,
      service: this.options.service,
      ...(context ? { context } : {}),
      message: text,
      ...(store?.correlationId ? { correlationId: store.correlationId } : {}),
      ...(store?.userId ? { userId: store.userId } : {}),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (!RESERVED.has(key)) entry[key] = redact(key, value, 0);
    }
    const finalStack = stack ?? errorStack;
    if (finalStack) entry.stack = finalStack;

    const json = safeStringify(entry);
    this.appendToFile?.(json);
    this.writeOut(this.format === 'pretty' ? prettyLine(entry) : json);
  }

  /**
   * Nest agrega el "context" (nombre de la clase) como último parámetro; en error() el stack
   * va antes. Hay que distinguir cuál es cuál.
   */
  private readParams(level: LogLevel, params: unknown[]): { context?: string; stack?: string } {
    const strings = params.filter((p): p is string => typeof p === 'string');
    if (strings.length === 0) return {};
    if (level !== 'error' && level !== 'fatal') return { context: strings[strings.length - 1] };
    if (strings.length >= 2) return { stack: strings[0], context: strings[strings.length - 1] };
    const only = strings[0];
    return /\n\s+at /.test(only) ? { stack: only } : { context: only };
  }

  private readMessage(message: unknown): { text: string; fields: Record<string, unknown>; errorStack?: string } {
    if (message instanceof Error) {
      return { text: message.message, fields: {}, errorStack: message.stack };
    }
    if (message !== null && typeof message === 'object') {
      const { message: inner, ...rest } = message as Record<string, unknown>;
      return { text: typeof inner === 'string' ? inner : '', fields: rest };
    }
    return { text: String(message), fields: {} };
  }
}

function redact(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Object]';
  if (Array.isArray(value)) return value.map((v) => redact('', v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(k, v, depth + 1)]));
}

/** JSON.stringify que nunca lanza (referencias circulares, BigInt). */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

function prettyLine(entry: Record<string, unknown>): string {
  const { timestamp, level, service, context, message, correlationId, userId, stack, ...extra } = entry;
  const time = String(timestamp).slice(11, 23);
  const parts = [`${time} ${String(level).toUpperCase().padEnd(5)} [${service}${context ? `/${context}` : ''}] ${message}`];
  if (Object.keys(extra).length > 0) parts.push(safeStringify(extra));
  if (correlationId) parts.push(`cid=${String(correlationId).slice(0, 8)}`);
  if (userId) parts.push(`user=${userId}`);
  if (stack) parts.push('\n' + String(stack));
  return parts.join('  ');
}

/** Crea el logger a partir de variables de entorno (LOG_LEVEL, LOG_FORMAT, LOG_DIR). */
export function createLogger(service: string, env: NodeJS.ProcessEnv = process.env): JsonLogger {
  const level = (env.LOG_LEVEL ?? 'info').toLowerCase();
  return new JsonLogger({
    service,
    level: level in ORDER ? (level as LogLevel) : 'info',
    format: env.LOG_FORMAT === 'pretty' ? 'pretty' : 'json',
    // LOG_DIR: además de la consola, cada servicio escribe <LOG_DIR>/<servicio>.log (Alloy lo lee y lo manda a Loki)
    file: env.LOG_DIR ? join(env.LOG_DIR, `${service}.log`) : undefined,
  });
}
