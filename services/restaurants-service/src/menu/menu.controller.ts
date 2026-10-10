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
  ApiQuery,
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
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { MenuService } from './menu.service';

@ApiTags('menu')
@Controller('restaurants/:restaurantId')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('menu')
  @ApiOperation({ summary: 'Carta del restaurante agrupada por categoría (público)' })
  @ApiQuery({
    name: 'includeUnavailable',
    required: false,
    type: Boolean,
    description: 'true = incluye también los platos no disponibles',
  })
  @ApiOkResponse({ description: '[{ category, items: [...] }]' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  getMenu(
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Query('includeUnavailable') includeUnavailable?: string,
  ) {
    return this.menu.getMenu(restaurantId, includeUnavailable === 'true');
  }

  @Post('menu-items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Agregar un plato a la carta (solo el dueño del restaurante)' })
  @ApiCreatedResponse({ description: 'Plato creado' })
  @ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
  @ApiForbiddenResponse({ description: 'No es el dueño de este restaurante' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  addItem(
    @CurrentUser() user: JwtPayload,
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.menu.addItem(restaurantId, user.sub, dto);
  }

  @Patch('menu-items/:itemId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Modificar un plato (solo el dueño del restaurante)' })
  @ApiOkResponse({ description: 'Plato actualizado' })
  @ApiForbiddenResponse({ description: 'No es el dueño de este restaurante' })
  @ApiNotFoundResponse({ description: 'No existe el restaurante o el plato' })
  updateItem(
    @CurrentUser() user: JwtPayload,
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Param('itemId', ParseObjectIdPipe) itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.menu.updateItem(restaurantId, itemId, user.sub, dto);
  }

  @Delete('menu-items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Quitar un plato de la carta (solo el dueño del restaurante)' })
  @ApiNoContentResponse({ description: 'Eliminado' })
  @ApiForbiddenResponse({ description: 'No es el dueño de este restaurante' })
  @ApiNotFoundResponse({ description: 'No existe el restaurante o el plato' })
  removeItem(
    @CurrentUser() user: JwtPayload,
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Param('itemId', ParseObjectIdPipe) itemId: string,
  ) {
    return this.menu.removeItem(restaurantId, itemId, user.sub);
  }
}
