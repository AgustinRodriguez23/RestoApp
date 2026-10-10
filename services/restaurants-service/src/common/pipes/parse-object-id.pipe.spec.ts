import { BadRequestException } from '@nestjs/common';
import { ParseObjectIdPipe } from './parse-object-id.pipe';

describe('ParseObjectIdPipe', () => {
  const pipe = new ParseObjectIdPipe();

  it('acepta un ObjectId válido', () => {
    expect(pipe.transform('64b7f0c2a1b2c3d4e5f60718')).toBe('64b7f0c2a1b2c3d4e5f60718');
  });

  it.each([
    ['vacío', ''],
    ['muy corto', '123'],
    ['no hexadecimal', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['con un operador de Mongo', '{"$gt":""}'],
    ['de 12 caracteres (válido para Mongoose pero no para esta API)', 'abcdefghijkl'],
  ])('rechaza un id inválido: %s', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
