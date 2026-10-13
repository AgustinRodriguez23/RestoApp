import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Ctx } from '../security/call-context.decorator';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { ListRestaurantsQueryDto, OverviewQueryDto } from './dto/restaurants.dto';
import { RestaurantsOverviewService } from './restaurants-overview.service';

@ApiTags('restaurants')
@Controller('restaurants')
export class RestaurantsController {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly overview: RestaurantsOverviewService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar restaurantes (paginado, con búsqueda y filtro por cocina)' })
  list(@Query() query: ListRestaurantsQueryDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { path: '/restaurants', query: { ...query } }, ctx);
  }

  @Get(':id/overview')
  @ApiOperation({
    summary: 'Pantalla de un restaurante en una sola llamada: detalle + carta + (opcional) horarios libres',
    description:
      'Agrega datos de restaurants-service y reservations-service. Si la carta o la disponibilidad fallan, ' +
      'igual responde el resto y las secciones faltantes vienen en null con un aviso en `warnings`.',
  })
  @ApiOkResponse({ description: '{ restaurant, menu, availability, warnings }' })
  getOverview(@Param('id', ParseObjectIdPipe) id: string, @Query() query: OverviewQueryDto, @Ctx() ctx: CallContext) {
    return this.overview.getOverview(id, query, ctx);
  }
}
