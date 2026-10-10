import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MenuItem } from '../menu/schemas/menu-item.schema';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { RestaurantsService } from './restaurants.service';
import { Restaurant } from './schemas/restaurant.schema';

/** Simula la cadena find().sort().skip().limit() de Mongoose. */
function findChain(result: unknown[]) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

describe('RestaurantsService', () => {
  let service: RestaurantsService;
  let model: {
    create: jest.Mock;
    find: jest.Mock;
    countDocuments: jest.Mock;
    findById: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    findByIdAndDelete: jest.Mock;
  };
  let menuItems: { deleteMany: jest.Mock };

  const OWNER = 'owner-1';
  const OTHER = 'owner-2';
  const ID = '64b7f0c2a1b2c3d4e5f60718';

  const validDto: CreateRestaurantDto = {
    name: 'La Parrilla',
    cuisine: 'Parrilla',
    address: 'Av. Mitre 1234',
    openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
    tables: [
      { number: 1, capacity: 4 },
      { number: 2, capacity: 2 },
    ],
  };

  beforeEach(async () => {
    model = {
      create: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
    };
    menuItems = { deleteMany: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RestaurantsService,
        { provide: getModelToken(Restaurant.name), useValue: model },
        { provide: getModelToken(MenuItem.name), useValue: menuItems },
      ],
    }).compile();
    service = moduleRef.get(RestaurantsService);
  });

  describe('create', () => {
    it('guarda el restaurante con el dueño tomado del token', async () => {
      model.create.mockResolvedValue({ id: ID });

      await service.create(OWNER, validDto);

      expect(model.create).toHaveBeenCalledWith({ ...validDto, ownerId: OWNER });
    });

    it('rechaza números de mesa repetidos', async () => {
      const dto = { ...validDto, tables: [{ number: 1, capacity: 4 }, { number: 1, capacity: 2 }] };

      await expect(service.create(OWNER, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(model.create).not.toHaveBeenCalled();
    });

    it('rechaza un turno que abre y cierra a la misma hora', async () => {
      const dto = { ...validDto, openingHours: [{ dayOfWeek: 1, opens: '10:00', closes: '10:00' }] };

      await expect(service.create(OWNER, dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta turnos que cruzan la medianoche', async () => {
      model.create.mockResolvedValue({ id: ID });

      // validDto cierra a la 01:00 (día siguiente)
      await expect(service.create(OWNER, validDto)).resolves.toBeDefined();
    });
  });

  describe('findAll', () => {
    it('pagina y calcula el total de páginas', async () => {
      const chain = findChain([{ id: 'a' }]);
      model.find.mockReturnValue(chain);
      model.countDocuments.mockResolvedValue(25);

      const result = await service.findAll({ page: 3, limit: 10 });

      expect(chain.skip).toHaveBeenCalledWith(20);
      expect(chain.limit).toHaveBeenCalledWith(10);
      expect(result).toMatchObject({ page: 3, limit: 10, total: 25, totalPages: 3 });
    });

    it('escapa los caracteres especiales de la búsqueda (no se interpreta como regex)', async () => {
      model.find.mockReturnValue(findChain([]));
      model.countDocuments.mockResolvedValue(0);

      await service.findAll({ search: 'a.b(c)' });

      expect(model.find).toHaveBeenCalledWith({
        name: { $regex: 'a\\.b\\(c\\)', $options: 'i' },
      });
    });

    it('filtra por tipo de cocina exacto', async () => {
      model.find.mockReturnValue(findChain([]));
      model.countDocuments.mockResolvedValue(0);

      await service.findAll({ cuisine: 'Parrilla' });

      expect(model.find).toHaveBeenCalledWith({
        cuisine: { $regex: '^Parrilla$', $options: 'i' },
      });
    });
  });

  describe('findOne / findOwned', () => {
    it('lanza 404 si el restaurante no existe', async () => {
      model.findById.mockResolvedValue(null);

      await expect(service.findOne(ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lanza 403 si el restaurante es de otro dueño', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });

      await expect(service.findOwned(ID, OTHER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('devuelve el restaurante si el usuario es el dueño', async () => {
      const restaurant = { id: ID, ownerId: OWNER };
      model.findById.mockResolvedValue(restaurant);

      await expect(service.findOwned(ID, OWNER)).resolves.toBe(restaurant);
    });
  });

  describe('update', () => {
    it('no modifica nada si no es el dueño', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });

      await expect(service.update(ID, OTHER, { name: 'Nuevo' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('actualiza con validadores de Mongoose activados', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });
      model.findByIdAndUpdate.mockResolvedValue({ id: ID, name: 'Nuevo' });

      await service.update(ID, OWNER, { name: 'Nuevo' });

      expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
        ID,
        { name: 'Nuevo' },
        { new: true, runValidators: true },
      );
    });

    it('también valida las reglas de negocio al modificar mesas', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });

      await expect(
        service.update(ID, OWNER, { tables: [{ number: 7, capacity: 2 }, { number: 7, capacity: 4 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('borra la carta y después el restaurante', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });

      await service.remove(ID, OWNER);

      expect(menuItems.deleteMany).toHaveBeenCalledTimes(1);
      expect(model.findByIdAndDelete).toHaveBeenCalledWith(ID);
    });

    it('no borra nada si no es el dueño', async () => {
      model.findById.mockResolvedValue({ id: ID, ownerId: OWNER });

      await expect(service.remove(ID, OTHER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(menuItems.deleteMany).not.toHaveBeenCalled();
      expect(model.findByIdAndDelete).not.toHaveBeenCalled();
    });
  });
});
