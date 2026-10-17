import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { CacheService } from '../cache/cache.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { MenuService } from './menu.service';
import { MenuItem } from './schemas/menu-item.schema';

describe('MenuService', () => {
  let service: MenuService;
  let items: {
    create: jest.Mock;
    find: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findOneAndDelete: jest.Mock;
  };
  let restaurants: { findOne: jest.Mock; findOwned: jest.Mock };
  let cache: { wrap: jest.Mock; invalidate: jest.Mock };

  const RESTAURANT_ID = '64b7f0c2a1b2c3d4e5f60718';
  const ITEM_ID = '64b7f0c2a1b2c3d4e5f60999';
  const OWNER = 'owner-1';

  const dto: CreateMenuItemDto = {
    category: 'Platos principales',
    name: 'Bife de chorizo',
    priceCents: 1250000,
  };

  beforeEach(async () => {
    items = {
      create: jest.fn(),
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
    };
    restaurants = { findOne: jest.fn().mockResolvedValue({}), findOwned: jest.fn().mockResolvedValue({}) };

    cache = { wrap: jest.fn((_key: string, loader: () => Promise<unknown>) => loader()), invalidate: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MenuService,
        { provide: getModelToken(MenuItem.name), useValue: items },
        { provide: RestaurantsService, useValue: restaurants },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = moduleRef.get(MenuService);
  });

  describe('addItem', () => {
    it('verifica que el usuario sea dueño antes de crear el plato', async () => {
      items.create.mockResolvedValue({ id: ITEM_ID });

      await service.addItem(RESTAURANT_ID, OWNER, dto);

      expect(restaurants.findOwned).toHaveBeenCalledWith(RESTAURANT_ID, OWNER);
      expect(items.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Bife de chorizo', priceCents: 1250000 }),
      );
    });

    it('no crea el plato si el usuario no es el dueño', async () => {
      restaurants.findOwned.mockRejectedValue(new ForbiddenException());

      await expect(service.addItem(RESTAURANT_ID, 'intruso', dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(items.create).not.toHaveBeenCalled();
    });
  });

  describe('getMenu', () => {
    const dish = (category: string, name: string) => ({ category, name });

    it('agrupa los platos por categoría respetando el orden recibido', async () => {
      items.find.mockReturnValue({
        sort: jest.fn().mockResolvedValue([
          dish('Entradas', 'Empanadas'),
          dish('Entradas', 'Provoleta'),
          dish('Postres', 'Flan'),
        ]),
      });

      const menu = await service.getMenu(RESTAURANT_ID);

      expect(menu).toHaveLength(2);
      expect(menu[0].category).toBe('Entradas');
      expect(menu[0].items).toHaveLength(2);
      expect(menu[1]).toMatchObject({ category: 'Postres' });
    });

    it('por defecto solo trae los platos disponibles', async () => {
      items.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

      await service.getMenu(RESTAURANT_ID);

      expect(items.find).toHaveBeenCalledWith(expect.objectContaining({ available: true }));
    });

    it('con includeUnavailable trae también los no disponibles', async () => {
      items.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

      await service.getMenu(RESTAURANT_ID, true);

      expect(items.find.mock.calls[0][0]).not.toHaveProperty('available');
    });

    it('lanza 404 si el restaurante no existe', async () => {
      restaurants.findOne.mockRejectedValue(new NotFoundException());

      await expect(service.getMenu(RESTAURANT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(items.find).not.toHaveBeenCalled();
    });
  });

  describe('updateItem', () => {
    it('lanza 404 si el plato no existe (o es de otro restaurante)', async () => {
      items.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.updateItem(RESTAURANT_ID, ITEM_ID, OWNER, { name: 'Nuevo' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('busca el plato dentro del restaurante indicado y activa los validadores', async () => {
      items.findOneAndUpdate.mockResolvedValue({ id: ITEM_ID });

      await service.updateItem(RESTAURANT_ID, ITEM_ID, OWNER, { available: false });

      const [filter, update, options] = items.findOneAndUpdate.mock.calls[0];
      expect(filter._id).toBe(ITEM_ID);
      expect(String(filter.restaurantId)).toBe(RESTAURANT_ID);
      expect(update).toEqual({ available: false });
      expect(options).toEqual({ new: true, runValidators: true });
    });

    it('no modifica nada si el usuario no es el dueño', async () => {
      restaurants.findOwned.mockRejectedValue(new ForbiddenException());

      await expect(
        service.updateItem(RESTAURANT_ID, ITEM_ID, 'intruso', { name: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(items.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('lanza 404 si el plato no existe', async () => {
      items.findOneAndDelete.mockResolvedValue(null);

      await expect(service.removeItem(RESTAURANT_ID, ITEM_ID, OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('elimina el plato si existe y el usuario es dueño', async () => {
      items.findOneAndDelete.mockResolvedValue({ id: ITEM_ID });

      await expect(service.removeItem(RESTAURANT_ID, ITEM_ID, OWNER)).resolves.toBeUndefined();
    });
  });

  describe('caché', () => {
    it('la carta se cachea por restaurante y según incluya o no platos no disponibles', async () => {
      items.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

      await service.getMenu(RESTAURANT_ID);
      await service.getMenu(RESTAURANT_ID, true);

      const [a, b] = cache.wrap.mock.calls.map((c) => c[0]);
      expect(a).toBe(`menu:${RESTAURANT_ID}:false`);
      expect(b).toBe(`menu:${RESTAURANT_ID}:true`);
    });

    it('agregar, modificar y quitar un plato invalidan el caché', async () => {
      items.create.mockResolvedValue({ id: ITEM_ID });
      items.findOneAndUpdate.mockResolvedValue({ id: ITEM_ID });
      items.findOneAndDelete.mockResolvedValue({ id: ITEM_ID });

      await service.addItem(RESTAURANT_ID, OWNER, dto);
      await service.updateItem(RESTAURANT_ID, ITEM_ID, OWNER, { available: false });
      await service.removeItem(RESTAURANT_ID, ITEM_ID, OWNER);

      expect(cache.invalidate).toHaveBeenCalledTimes(3);
    });

    it('si el plato no existe (404) no invalida nada', async () => {
      items.findOneAndUpdate.mockResolvedValue(null);
      items.findOneAndDelete.mockResolvedValue(null);

      await expect(service.updateItem(RESTAURANT_ID, ITEM_ID, OWNER, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.removeItem(RESTAURANT_ID, ITEM_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);

      expect(cache.invalidate).not.toHaveBeenCalled();
    });
  });
});
