import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOperation({
    summary: 'Horarios disponibles de un restaurante en un día, para un grupo (público)',
    description:
      'Devuelve solo los horarios en los que queda al menos una mesa libre con capacidad suficiente. ' +
      'Es una foto del momento: al reservar puede responder 409 si otra persona tomó la mesa antes.',
  })
  @ApiOkResponse({ description: '{ restaurantId, date, partySize, durationMinutes, timeZone, slots: [{ startsAt, endsAt, availableTables }] }' })
  @ApiBadRequestResponse({ description: 'Fecha o parámetros inválidos' })
  @ApiNotFoundResponse({ description: 'No existe un restaurante con ese id' })
  @ApiServiceUnavailableResponse({ description: 'restaurants-service no responde' })
  get(@Query() query: AvailabilityQueryDto) {
    return this.availability.getAvailability(query);
  }
}
