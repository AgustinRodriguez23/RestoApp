import { model, Types } from 'mongoose';
import { Allergen, MenuItemSchema } from './menu/schemas/menu-item.schema';
import { RestaurantSchema } from './restaurants/schemas/restaurant.schema';

/**
 * Los modelos de Mongoose se pueden instanciar y validar sin conexión a la base:
 * así se prueban las reglas de los schemas y cómo se serializan hacia afuera.
 */
const RestaurantModel = model('SchemaTestRestaurant', RestaurantSchema);
const MenuItemModel = model('SchemaTestMenuItem', MenuItemSchema);

const validRestaurant = {
  ownerId: 'owner-1',
  name: 'La Parrilla',
  cuisine: 'Parrilla',
  address: 'Av. Mitre 1234',
  openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
  tables: [{ number: 1, capacity: 4 }],
};

const validItem = {
  restaurantId: new Types.ObjectId(),
  category: 'Postres',
  name: 'Flan',
  priceCents: 450000,
};

describe('schema Restaurant', () => {
  it('es válido con los datos mínimos', () => {
    expect(new RestaurantModel(validRestaurant).validateSync()).toBeUndefined();
  });

  it.each(['ownerId', 'name', 'cuisine', 'address'])('exige el campo %s', (field) => {
    const doc = new RestaurantModel({ ...validRestaurant, [field]: undefined });

    expect(doc.validateSync()?.errors[field]).toBeDefined();
  });

  it('rechaza mesas con capacidad fuera de rango', () => {
    const doc = new RestaurantModel({ ...validRestaurant, tables: [{ number: 1, capacity: 51 }] });

    expect(doc.validateSync()).toBeDefined();
  });

  it('rechaza un día de la semana inválido', () => {
    const doc = new RestaurantModel({
      ...validRestaurant,
      openingHours: [{ dayOfWeek: 7, opens: '10:00', closes: '12:00' }],
    });

    expect(doc.validateSync()).toBeDefined();
  });

  it('recorta espacios en el nombre', () => {
    expect(new RestaurantModel({ ...validRestaurant, name: '  La Parrilla  ' }).name).toBe('La Parrilla');
  });

  it('se serializa con "id" y sin "_id" ni "__v"', () => {
    const json = new RestaurantModel(validRestaurant).toJSON() as unknown as Record<string, unknown>;

    expect(json.id).toEqual(expect.any(String));
    expect(json).not.toHaveProperty('_id');
    expect(json).not.toHaveProperty('__v');
  });

  it('las mesas y horarios no generan un _id propio', () => {
    const json = new RestaurantModel(validRestaurant).toJSON() as unknown as {
      tables: Record<string, unknown>[];
    };

    expect(json.tables[0]).toEqual({ number: 1, capacity: 4 });
  });
});

describe('schema MenuItem', () => {
  it('es válido con los datos mínimos y toma valores por defecto', () => {
    const doc = new MenuItemModel(validItem);

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.available).toBe(true);
    expect(doc.allergens).toEqual([]);
    expect(doc.variants).toEqual([]);
  });

  it('rechaza un precio negativo', () => {
    expect(new MenuItemModel({ ...validItem, priceCents: -1 }).validateSync()?.errors.priceCents).toBeDefined();
  });

  it('acepta alérgenos conocidos y rechaza desconocidos', () => {
    const ok = new MenuItemModel({ ...validItem, allergens: [Allergen.GLUTEN, Allergen.MILK] });
    const bad = new MenuItemModel({ ...validItem, allergens: ['CHOCOLATE'] });

    expect(ok.validateSync()).toBeUndefined();
    expect(bad.validateSync()).toBeDefined();
  });

  it('exige el restaurante al que pertenece el plato', () => {
    const doc = new MenuItemModel({ ...validItem, restaurantId: undefined });

    expect(doc.validateSync()?.errors.restaurantId).toBeDefined();
  });

  it('las variantes pueden restar precio', () => {
    const doc = new MenuItemModel({
      ...validItem,
      variants: [{ name: 'Media porción', priceDeltaCents: -150000 }],
    });

    expect(doc.validateSync()).toBeUndefined();
  });

  it('tiene un índice por restaurante y categoría (la consulta de la carta)', () => {
    const indexes = MenuItemSchema.indexes().map(([fields]) => fields);

    expect(indexes).toContainEqual({ restaurantId: 1, category: 1 });
  });
});
