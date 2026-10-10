import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { applyJsonTransform } from '../../common/mongoose-json';

/** Los 14 alérgenos de declaración obligatoria (lista de la UE, la más usada como referencia). */
export enum Allergen {
  GLUTEN = 'GLUTEN',
  CRUSTACEANS = 'CRUSTACEANS',
  EGGS = 'EGGS',
  FISH = 'FISH',
  PEANUTS = 'PEANUTS',
  SOY = 'SOY',
  MILK = 'MILK',
  TREE_NUTS = 'TREE_NUTS',
  CELERY = 'CELERY',
  MUSTARD = 'MUSTARD',
  SESAME = 'SESAME',
  SULPHITES = 'SULPHITES',
  LUPIN = 'LUPIN',
  MOLLUSCS = 'MOLLUSCS',
}

/** Variante de un plato (ej: "Porción grande", "Sin sal"). */
@Schema({ _id: false })
export class MenuVariant {
  @Prop({ required: true, trim: true })
  name: string;

  /** Diferencia de precio respecto del plato base, en centavos (puede ser negativa). */
  @Prop({ required: true, default: 0 })
  priceDeltaCents: number;
}
export const MenuVariantSchema = SchemaFactory.createForClass(MenuVariant);

@Schema({ timestamps: true })
export class MenuItem {
  @Prop({ type: Types.ObjectId, ref: 'Restaurant', required: true })
  restaurantId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  category: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  /**
   * Precio en centavos (entero). El dinero nunca se guarda como decimal flotante:
   * 0.1 + 0.2 !== 0.3 en coma flotante, y eso en pagos es un bug.
   */
  @Prop({ required: true, min: 0 })
  priceCents: number;

  @Prop({ type: [String], enum: Object.values(Allergen), default: [] })
  allergens: Allergen[];

  @Prop({ type: [MenuVariantSchema], default: [] })
  variants: MenuVariant[];

  @Prop({ default: true })
  available: boolean;
}

export type MenuItemDocument = HydratedDocument<MenuItem>;
export const MenuItemSchema = SchemaFactory.createForClass(MenuItem);
MenuItemSchema.index({ restaurantId: 1, category: 1 });
applyJsonTransform(MenuItemSchema);
