import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { CreateMenuItemDto, UpdateMenuItemDto } from './dto/menu-item-input.dto';

/**
 * Carta de un restaurante del dueño. Igual que el resto del módulo owner: el BFF valida la forma y reenvía;
 * que el restaurante sea del usuario lo decide restaurants-service.
 */
@ApiTags('owner')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@ApiForbiddenResponse({ description: 'No sos dueño de este restaurante' })
@Controller('owner/restaurants/:restaurantId')
export class OwnerMenuController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get('menu')
  @ApiOperation({ summary: 'Carta completa agrupada por categoría, incluyendo los platos no disponibles' })
  menu(@Param('restaurantId', ParseObjectIdPipe) restaurantId: string, @Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { path: `/restaurants/${restaurantId}/menu`, query: { includeUnavailable: 'true' } }, ctx);
  }

  @Post('menu-items')
  @ApiOperation({ summary: 'Agregar un plato' })
  add(@Param('restaurantId', ParseObjectIdPipe) restaurantId: string, @Body() dto: CreateMenuItemDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { method: 'POST', path: `/restaurants/${restaurantId}/menu-items`, body: dto }, ctx);
  }

  @Patch('menu-items/:itemId')
  @ApiOperation({ summary: 'Modificar un plato (también para pausarlo con available: false)' })
  update(
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Param('itemId', ParseObjectIdPipe) itemId: string,
    @Body() dto: UpdateMenuItemDto,
    @Ctx() ctx: CallContext,
  ) {
    return this.upstream.call('restaurants', { method: 'PATCH', path: `/restaurants/${restaurantId}/menu-items/${itemId}`, body: dto }, ctx);
  }

  @Delete('menu-items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar un plato' })
  async remove(
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Param('itemId', ParseObjectIdPipe) itemId: string,
    @Ctx() ctx: CallContext,
  ) {
    await this.upstream.call('restaurants', { method: 'DELETE', path: `/restaurants/${restaurantId}/menu-items/${itemId}` }, ctx);
  }
}
