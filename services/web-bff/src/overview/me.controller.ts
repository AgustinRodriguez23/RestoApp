import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext } from '../upstream/upstream-client';
import { MeOverviewService } from './me-overview.service';

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly overview: MeOverviewService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Pantalla de inicio: mi perfil + mis próximas 5 reservas' })
  @ApiOkResponse({ description: '{ user, upcomingReservations, warnings }' })
  get(@Ctx() ctx: CallContext) {
    return this.overview.getOverview(ctx);
  }
}
