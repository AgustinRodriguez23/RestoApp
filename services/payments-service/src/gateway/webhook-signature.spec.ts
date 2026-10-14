import { InvalidWebhookError } from './payment-gateway';
import { SIGNATURE_TOLERANCE_SECONDS, signWebhook, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'whsec_test';
const NOW = 1_800_000_000;
const body = Buffer.from(JSON.stringify({ eventId: 'evt_1', type: 'charge.succeeded', chargeId: 'ch_1' }));

describe('firma de webhooks (HMAC-SHA256)', () => {
  it('acepta una firma válida', () => {
    const header = signWebhook(SECRET, body, NOW);

    expect(() => verifyWebhookSignature(SECRET, body, header, NOW)).not.toThrow();
  });

  it('el header tiene la forma t=<unix>,v1=<hex de 64 caracteres>', () => {
    expect(signWebhook(SECRET, body, NOW)).toMatch(new RegExp(`^t=${NOW},v1=[0-9a-f]{64}$`));
  });

  it('rechaza si el cuerpo fue modificado (aunque sea un caracter)', () => {
    const header = signWebhook(SECRET, body, NOW);
    const tampered = Buffer.from(body.toString().replace('charge.succeeded', 'charge.failed'));

    expect(() => verifyWebhookSignature(SECRET, tampered, header, NOW)).toThrow(/no coincide/);
  });

  it('rechaza una firma hecha con otro secreto', () => {
    const header = signWebhook('otro-secreto', body, NOW);

    expect(() => verifyWebhookSignature(SECRET, body, header, NOW)).toThrow(InvalidWebhookError);
  });

  it('rechaza si cambian el timestamp (viene dentro de lo firmado)', () => {
    const header = signWebhook(SECRET, body, NOW);
    const forged = header.replace(`t=${NOW}`, `t=${NOW + 10}`);

    expect(() => verifyWebhookSignature(SECRET, body, forged, NOW + 10)).toThrow(/no coincide/);
  });

  it('rechaza un webhook viejo (repetición de un mensaje capturado)', () => {
    const header = signWebhook(SECRET, body, NOW);

    expect(() => verifyWebhookSignature(SECRET, body, header, NOW + SIGNATURE_TOLERANCE_SECONDS + 1)).toThrow(/vencida/);
  });

  it('tolera hasta 5 minutos de diferencia de reloj, hacia los dos lados', () => {
    const header = signWebhook(SECRET, body, NOW);

    expect(() => verifyWebhookSignature(SECRET, body, header, NOW + SIGNATURE_TOLERANCE_SECONDS)).not.toThrow();
    expect(() => verifyWebhookSignature(SECRET, body, header, NOW - SIGNATURE_TOLERANCE_SECONDS)).not.toThrow();
    expect(() => verifyWebhookSignature(SECRET, body, header, NOW - SIGNATURE_TOLERANCE_SECONDS - 1)).toThrow(/vencida/);
  });

  it.each([undefined, '', 'basura', 't=abc,v1=00', `t=${NOW}`, `v1=${'0'.repeat(64)}`])('rechaza un header ausente o malformado (%p)', (header) => {
    expect(() => verifyWebhookSignature(SECRET, body, header, NOW)).toThrow(InvalidWebhookError);
  });

  it('rechaza una firma que no es hexadecimal o tiene otro largo, sin romperse', () => {
    expect(() => verifyWebhookSignature(SECRET, body, `t=${NOW},v1=zzzz`, NOW)).toThrow(InvalidWebhookError);
    expect(() => verifyWebhookSignature(SECRET, body, `t=${NOW},v1=abcd`, NOW)).toThrow(InvalidWebhookError);
  });

  it('acepta el header como arreglo (cuando Express repite el header)', () => {
    const header = signWebhook(SECRET, body, NOW);

    expect(() => verifyWebhookSignature(SECRET, body, [header], NOW)).not.toThrow();
  });
});
