import { createServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedCall {
  method: string;
  path: string; // incluye la query
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Texto crudo en vez de JSON (para simular respuestas rotas). */
  raw?: string;
  delayMs?: number;
  /** Headers de respuesta extra. */
  headers?: Record<string, string>;
}

export type FakeHandler = (call: RecordedCall) => FakeReply | Promise<FakeReply>;

/**
 * Un servidor HTTP REAL y programable que hace de "otro microservicio" en los tests.
 * Como el BFF usa fetch de verdad, se prueba todo el camino de red (headers, timeouts,
 * conexiones rechazadas) y no solo funciones con mocks.
 */
export class FakeService {
  calls: RecordedCall[] = [];
  handler: FakeHandler = () => ({ status: 404, body: { message: 'sin handler' } });
  private server!: Server;

  static async start(): Promise<FakeService> {
    const fake = new FakeService();
    fake.server = createServer((req, res) => {
      fake.handle(req, res).catch(() => {
        // un handler de test que explota no debe tirar el proceso: respondemos 500
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const call: RecordedCall = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body: await readJson(req),
    };
    this.calls.push(call);
    const reply = await this.handler(call);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.statusCode = reply.status ?? 200;
    res.setHeader('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Llamadas hechas a una ruta (sin la query), para afirmar "se llamó N veces". */
  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path.split('?')[0] === path);
  }

  reset(handler?: FakeHandler): void {
    this.calls = [];
    if (handler) this.handler = handler;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}
