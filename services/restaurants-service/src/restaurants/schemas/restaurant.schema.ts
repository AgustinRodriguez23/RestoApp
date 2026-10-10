import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { applyJsonTransform } from '../../common/mongoose-json';

/** Un turno de atención. Un día puede tener varios (ej: almuerzo y cena). */
@Schema({ _id: false })
export class OpeningHours {
  @Prop({ required: true, min: 0, max: 6 })
  dayOfWeek: number; // 0 = domingo ... 6 = sábado

  @Prop({ required: true })
  opens: string; // "HH:mm"

  @Prop({ required: true })
  closes: string; // "HH:mm". Si es menor que opens, cierra al día siguiente.
}
export const OpeningHoursSchema = SchemaFactory.createForClass(OpeningHours);

@Schema({ _id: false })
export class RestaurantTable {
  @Prop({ required: true, min: 1 })
  number: number;

  @Prop({ required: true, min: 1, max: 50 })
  capacity: number;
}
export const RestaurantTableSchema = SchemaFactory.createForClass(RestaurantTable);

@Schema({ timestamps: true })
export class Restaurant {
  /** Id del usuario (de auth-service) que es dueño. Es una referencia lógica, no una FK. */
  @Prop({ required: true, index: true })
  ownerId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ required: true, trim: true, index: true })
  cuisine: string;

  @Prop({ required: true, trim: true })
  address: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ type: [OpeningHoursSchema], default: [] })
  openingHours: OpeningHours[];

  @Prop({ type: [RestaurantTableSchema], default: [] })
  tables: RestaurantTable[];
}

export type RestaurantDocument = HydratedDocument<Restaurant>;
export const RestaurantSchema = SchemaFactory.createForClass(Restaurant);
applyJsonTransform(RestaurantSchema);
