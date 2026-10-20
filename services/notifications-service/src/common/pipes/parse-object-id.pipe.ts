import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/** Valida que un parámetro de ruta sea un ObjectId de MongoDB (24 caracteres hexadecimales). */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!OBJECT_ID_REGEX.test(value)) {
      throw new BadRequestException('El id no tiene un formato válido');
    }
    return value;
  }
}
