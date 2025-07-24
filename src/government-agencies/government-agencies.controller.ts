import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { GovernmentAgenciesService } from './government-agencies.service';
import { CreateGovernmentAgencyDto } from './dto/create-government-agency.dto';
import { UpdateGovernmentAgencyDto } from './dto/update-government-agency.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'government-agencies',
  version: '1',
})
// @UseGuards(JwtAuthGuard)
export class GovernmentAgenciesController {
  constructor(
    private readonly governmentAgenciesService: GovernmentAgenciesService,
  ) {}

  @Post()
  create(@Body() createGovernmentAgencyDto: CreateGovernmentAgencyDto) {
    return this.governmentAgenciesService.create(createGovernmentAgencyDto);
  }

  @Get()
  findAll() {
    return this.governmentAgenciesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.governmentAgenciesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateGovernmentAgencyDto: UpdateGovernmentAgencyDto,
  ) {
    return this.governmentAgenciesService.update(id, updateGovernmentAgencyDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.governmentAgenciesService.softRemove(id)
      : this.governmentAgenciesService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.governmentAgenciesService.restore(id);
  }
}
