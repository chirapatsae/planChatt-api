import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  UseGuards,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { StatusService } from './status.service';
import { CreateStatusDto } from './dto/create-status.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'status',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class StatusController {
  private readonly logger = new Logger(StatusController.name);
  constructor(private readonly statusService: StatusService) {}

  @Post()
  create(
    @Body() dto: CreateStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to create status: ${dto.name}`);
    return this.statusService.create(dto, req.user.userId);
  }

  @Get()
  findAll() {
    this.logger.log('Request to fetch all status');
    return this.statusService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to fetch status with ID: ${id}`);
    return this.statusService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStatusDto) {
    this.logger.log(`Request to update status with ID: ${id}`);
    return this.statusService.update(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return mode === 'soft'
      ? this.statusService.softRemove(id, req.user.userId) // Only pass id, not userId
      : this.statusService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.statusService.restore(id);
  }
}
