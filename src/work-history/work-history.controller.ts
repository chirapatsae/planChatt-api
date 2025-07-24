import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  Request,
  Query,
  Req,
} from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'work-history',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class WorkHistoryController {
  constructor(private readonly workHistoryService: WorkHistoryService) {}

  @Get()
  findAll(@Query('status') status: string, @Query('role') role: string) {
    return this.workHistoryService.findAll(status, role);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateWorkHistoryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryService.create(dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkHistoryDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryService.update(id, dto, req.user.userId);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.workHistoryService.softRemove(id)
      : this.workHistoryService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.workHistoryService.restore(id);
  }
}
