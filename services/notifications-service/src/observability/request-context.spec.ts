import { currentCorrelationId, getRequestContext, runWithContext, setCurrentUserId } from './request-context';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('request-context (AsyncLocalStorage)', () => {
  it('fuera de una request no hay contexto', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(currentCorrelationId()).toBeUndefined();
    expect(() => setCurrentUserId('x')).not.toThrow(); // no hace nada, pero tampoco rompe
  });

  it('el contexto sobrevive a await, promesas y timers', async () => {
    await runWithContext({ correlationId: 'abc-12345678' }, async () => {
      await sleep(5);
      expect(currentCorrelationId()).toBe('abc-12345678');
      await Promise.resolve().then(() => expect(currentCorrelationId()).toBe('abc-12345678'));
      await new Promise<void>((resolve) => setTimeout(() => {
        expect(currentCorrelationId()).toBe('abc-12345678');
        resolve();
      }, 5));
    });
  });

  it('requests simultáneas NO se mezclan entre sí', async () => {
    const seen: Record<string, string[]> = {};
    const handle = (id: string, delays: number[]) =>
      runWithContext({ correlationId: id }, async () => {
        seen[id] = [];
        for (const delay of delays) {
          await sleep(delay);
          seen[id].push(currentCorrelationId()!);
        }
      });

    await Promise.all([handle('req-A-1234', [10, 1, 10]), handle('req-B-1234', [1, 10, 1]), handle('req-C-1234', [5, 5, 5])]);

    for (const id of Object.keys(seen)) expect(new Set(seen[id])).toEqual(new Set([id]));
  });

  it('el contexto no se filtra después de terminar', async () => {
    await runWithContext({ correlationId: 'temporal-1234' }, async () => sleep(1));

    expect(currentCorrelationId()).toBeUndefined();
  });

  it('setCurrentUserId completa el contexto de la request actual', () => {
    runWithContext({ correlationId: 'abc-12345678' }, () => {
      setCurrentUserId('user-9');

      expect(getRequestContext()).toEqual({ correlationId: 'abc-12345678', userId: 'user-9' });
    });
  });
});
