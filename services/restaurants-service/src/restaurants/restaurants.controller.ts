import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { JwtPayload } from '../security/jwt-payload';
import { Role } from '../security/role.enum';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { ListRestaurantsQueryDto } from './dto/list-restaurants-query.dto';
import { UpdateRestaurantDto } from './dto/update-restaurant.dto';
import { RestaurantsService } from './restaurants.service';

@ApiTags('restaurants')
@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar restaurantes (público, paginado)' })
  @ApiOkResponse({ description: '{ data, page, limit, total, totalPages }' })
  findAll(@Query() query: ListRestaurantsQueryDto) {
    return this.restaurants.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver un restaurante (público)' })
  @ApiOkResponse({ description: 'El restaurante con sus mesas y horarios' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.restaurants.findPublic(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear un restaurante (solo RESTAURANT_OWNER)' })
  @ApiCreatedResponse({ description: 'Restaurante creado; el dueño es el usuario del token' })
  @ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
  @ApiForbiddenResponse({ description: 'El usuario no tiene rol RESTAURANT_OWNER' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateRestaurantDto) {
    return this.restaurants.create(user.sub, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Modificar un restaurante (solo su dueño)' })
  @ApiOkResponse({ description: 'Restaurante actualizado' })
  @ApiForbiddenResponse({ description: 'No es el dueño de este restaurante' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.restaurants.update(id, user.sub, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Eliminar un restaurante y su carta (solo su dueño)' })
  @ApiNoContentResponse({ description: 'Eliminado' })
  @ApiForbiddenResponse({ description: 'No es el dueño de este restaurante' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  remove(@CurrentUser() user: JwtPayload, @Param('id', ParseObjectIdPipe) id: string) {
    return this.restaurants.remove(id, user.sub);
  }
}
