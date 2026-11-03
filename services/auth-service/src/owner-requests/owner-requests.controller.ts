import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Role } from '../users/role.enum';
import {
  CreateOwnerRequestDto,
  ListOwnerRequestsQueryDto,
  OwnerRequestPageDto,
  OwnerRequestResponseDto,
  RejectOwnerRequestDto,
} from './dto/owner-request.dto';
import { OwnerRequestsService } from './owner-requests.service';

@ApiTags('owner-requests')
@ApiBearerAuth()
@Controller('owner-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OwnerRequestsController {
  constructor(private readonly requests: OwnerRequestsService) {}

  @Post()
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Pedir ser dueño de restaurante' })
  @ApiCreatedResponse({ type: OwnerRequestResponseDto })
  @ApiConflictResponse({ description: 'Ya tiene una solicitud pendiente' })
  @ApiForbiddenResponse({ description: 'La cuenta no es de cliente' })
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateOwnerRequestDto): Promise<OwnerRequestResponseDto> {
    return this.requests.create(req.user.sub, dto);
  }

  // Sin @Roles: el que ya fue aprobado (dueño) también puede ver la suya
  @Get('mine')
  @ApiOperation({ summary: 'La última solicitud del usuario, con su estado' })
  @ApiOkResponse({ type: OwnerRequestResponseDto })
  @ApiNotFoundResponse({ description: 'Todavía no envió ninguna' })
  findMine(@Req() req: AuthenticatedRequest): Promise<OwnerRequestResponseDto> {
    return this.requests.findMine(req.user.sub);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Solicitudes por estado (admin)' })
  @ApiOkResponse({ type: OwnerRequestPageDto })
  list(@Query() query: ListOwnerRequestsQueryDto): Promise<OwnerRequestPageDto> {
    return this.requests.list(query);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Aprobar: el usuario pasa a ser dueño (admin)' })
  @ApiOkResponse({ type: OwnerRequestResponseDto })
  @ApiNotFoundResponse({ description: 'No existe' })
  @ApiConflictResponse({ description: 'Ya fue revisada' })
  approve(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<OwnerRequestResponseDto> {
    return this.requests.approve(id, req.user.sub);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Rechazar con un motivo, que ve el usuario (admin)' })
  @ApiOkResponse({ type: OwnerRequestResponseDto })
  @ApiNotFoundResponse({ description: 'No existe' })
  @ApiConflictResponse({ description: 'Ya fue revisada' })
  reject(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectOwnerRequestDto,
  ): Promise<OwnerRequestResponseDto> {
    return this.requests.reject(id, req.user.sub, dto.reason);
  }
}
