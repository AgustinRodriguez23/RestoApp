import { describe, expect, it } from 'vitest';
import { allergenLabel, dateInputValue, formatDay, formatMoney, formatTime, newIdempotencyKey, remaining } from './format';

describe('format', () => {
  it('formatMoney muestra los centavos solo cuando existen (no redondea un precio con centavos)', () => {
    expect(formatMoney(450050)).toMatch(/4\.500,50/);
    expect(formatMoney(450000)).not.toMatch(/,/);
    expect(formatMoney(1999)).toMatch(/19,99/);
    expect(formatMoney(400000)).toMatch(/4\.000/);
    expect(formatMoney(850000)).toMatch(/8\.500/);
  });

  it('formatTime y formatDay usan la zona del restaurante, no la del navegador', () => {
    // 00:00 UTC = 21:00 del día anterior en Buenos Aires (UTC-3)
    expect(formatTime('2026-10-17T00:00:00.000Z', 'America/Argentina/Buenos_Aires')).toBe('21:00');
    expect(formatDay('2026-10-17T00:00:00.000Z', 'America/Argentina/Buenos_Aires')).toMatch(/^Viernes, 16 de octubre/);
  });

  it('dateInputValue da YYYY-MM-DD en la zona del restaurante', () => {
    // 01:00 UTC del 17 todavía es 16 en Buenos Aires
    expect(dateInputValue(0, new Date('2026-10-17T01:00:00Z'))).toBe('2026-10-16');
    expect(dateInputValue(2, new Date('2026-10-17T01:00:00Z'))).toBe('2026-10-18');
  });

  it('remaining cuenta hacia atrás y es null cuando venció', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(remaining('2026-10-16T12:14:05Z', now)).toBe('14:05');
    expect(remaining('2026-10-16T12:00:09Z', now)).toBe('0:09');
    expect(remaining('2026-10-16T12:00:00Z', now)).toBeNull();
    expect(remaining('2026-10-16T11:00:00Z', now)).toBeNull();
  });

  it('allergenLabel traduce los códigos y deja pasar los desconocidos', () => {
    expect(allergenLabel('MILK')).toBe('lácteos');
    expect(allergenLabel('ALGO_NUEVO')).toBe('algo_nuevo');
  });

  it('newIdempotencyKey genera claves distintas y válidas para el backend (8-100 chars)', () => {
    const a = newIdempotencyKey();
    expect(a).not.toBe(newIdempotencyKey());
    expect(a).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });
});
