import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MenuController } from './menu/menu.controller';
import { MenuModule } from './menu/menu.module';
import { MenuService } from './menu/menu.service';
import { RestaurantsController } from './restaurants/restaurants.controller';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { RestaurantsService } from './restaurants/restaurants.service';

/** Conexión falsa: alcanza para que Nest resuelva los modelos sin conectarse a MongoDB. */
@Global()
@Module({
  providers: [
    {
      provide: getConnectionToken(),
      // @nestjs/mongoose mira connection.models antes de crear cada modelo
      useValue: { models: {}, model: (name: string) => ({ modelName: name }) },
    },
  ],
  exports: [getConnectionToken()],
})
class FakeConnectionModule {}

describe('cableado de módulos (inyección de dependencias)', () => {
  it('RestaurantsModule y MenuModule resuelven todas sus dependencias', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: 'secreto-solo-para-tests' })],
        }),
        FakeConnectionModule,
        RestaurantsModule,
        MenuModule,
      ],
    }).compile();

    expect(moduleRef.get(RestaurantsService)).toBeInstanceOf(RestaurantsService);
    expect(moduleRef.get(MenuService)).toBeInstanceOf(MenuService);
    expect(moduleRef.get(RestaurantsController)).toBeDefined();
    expect(moduleRef.get(MenuController)).toBeDefined();
  });

  it('sin JWT_SECRET el servicio no arranca', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
          FakeConnectionModule,
          RestaurantsModule,
        ],
      }).compile(),
    ).rejects.toThrow(/JWT_SECRET/);
  });
});
