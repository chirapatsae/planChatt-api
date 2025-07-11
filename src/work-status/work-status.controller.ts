import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query } from '@nestjs/common';
import { WorkStatusService } from './work-status.service';
import { CreateWorkStatusDto } from './dto/create-work-status.dto';
import { UpdateWorkStatusDto } from './dto/update-work-status.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path : 'work-status',
  version : '1'
})
// @UseGuards(JwtAuthGuard)
export class WorkStatusController {
  constructor(private readonly workStatusService: WorkStatusService) {}

  @Post()
  create(@Body() createWorkStatusDto: CreateWorkStatusDto) {
    return this.workStatusService.create(createWorkStatusDto);
  }

  @Get()
  findAll() {
    return this.workStatusService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.workStatusService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateWorkStatusDto: UpdateWorkStatusDto) {
    return this.workStatusService.update(id, updateWorkStatusDto);
  }


  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.workStatusService.softRemove(id)
      : this.workStatusService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.workStatusService.restore(id);
  }
}
