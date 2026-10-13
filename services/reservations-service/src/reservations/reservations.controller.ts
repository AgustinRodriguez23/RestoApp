import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
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
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsQueryDto, ListRestaurantReservationsQueryDto } from './dto/list-reservations-query.dto';
import { ReservationDto } from './dto/reservation.dto';
import { UpdateReservationStatusDto } from './dto/update-reservation-status.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Crear una reserva',
    description:
      'La mesa se asigna sola: la más chica en la que entre el grupo y que esté libre. ' +
      'Si dos personas piden el mismo horario a la vez, solo una lo consigue y la otra recibe 409.',
  })
  @ApiCreatedResponse({ type: ReservationDto })
  @ApiBadRequestResponse({ description: 'Horario inválido, fuera de turno, pasado, o sin mesas para ese grupo' })
  @ApiConflictResponse({ description: 'No quedan mesas libres en ese horario' })
  @ApiServiceUnavailableResponse({ description: 'restaurants-service no responde' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateReservationDto) {
    return this.reservations.create(user, dto);
  }

  // Las rutas fijas ("mine", "restaurant/...") van antes que ":id" para que no se confundan con un id.

  @Get('mine')
  @ApiOperation({ summary: 'Mis reservas (paginado, más recientes primero)' })
  @ApiOkResponse({ description: '{ data: Reservation[], page, limit, total, totalPages }' })
  listMine(@CurrentUser() user: JwtPayload, @Query() query: ListReservationsQueryDto) {
    return this.reservations.listMine(user, query);
  }

  @Get('restaurant/:restaurantId')
  @Roles(Role.RESTAURANT_OWNER)
  @ApiOperation({ summary: 'Reservas de un restaurante (solo su dueño). Filtros: date, status' })
  @ApiOkResponse({ description: '{ data: Reservation[], page, limit, total, totalPages }' })
  @ApiForbiddenResponse({ description: 'El usuario no tiene rol RESTAURANT_OWNER' })
  @ApiNotFoundResponse({ description: 'No existe, o no es dueño de ese restaurante' })
  listForRestaurant(
    @CurrentUser() user: JwtPayload,
    @Param('restaurantId', ParseObjectIdPipe) restaurantId: string,
    @Query() query: ListRestaurantReservationsQueryDto,
  ) {
    return this.reservations.listForRestaurant(restaurantId, user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una reserva (quien la hizo o el dueño del restaurante)' })
  @ApiOkResponse({ type: ReservationDto })
  @ApiNotFoundResponse({ description: 'No existe, o no tenés acceso a ella' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.findOne(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar una reserva (quien la hizo o el dueño), solo antes de que empiece' })
  @ApiOkResponse({ type: ReservationDto })
  @ApiBadRequestResponse({ description: 'La reserva ya comenzó' })
  @ApiConflictResponse({ description: 'La reserva ya no está confirmada' })
  @ApiNotFoundResponse({ description: 'No existe, o no tenés acceso a ella' })
  cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.cancel(id, user);
  }

  @Patch(':id/status')
  @Roles(Role.RESTAURANT_OWNER)
  @ApiOperation({ summary: 'Marcar una reserva como COMPLETED o NO_SHOW (solo el dueño, una vez que empezó)' })
  @ApiOkResponse({ type: ReservationDto })
  @ApiBadRequestResponse({ description: 'La reserva todavía no empezó' })
  @ApiConflictResponse({ description: 'La reserva ya no está confirmada' })
  @ApiForbiddenResponse({ description: 'El usuario no tiene rol RESTAURANT_OWNER' })
  @ApiNotFoundResponse({ description: 'No existe, o no es del restaurante del usuario' })
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReservationStatusDto,
  ) {
    return this.reservations.updateStatus(id, user, dto.status);
  }
}
