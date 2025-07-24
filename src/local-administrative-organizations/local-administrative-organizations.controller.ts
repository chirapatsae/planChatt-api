// src/local-administrative-organizations/local-administrative-organizations.controller.ts

import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';
import { CreateLocalAdministrativeOrganizationDto } from './dto/create-local-administrative-organization.dto';
import { UpdateLocalAdministrativeOrganizationDto } from './dto/update-local-administrative-organization.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'local-administrative-organizations',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class LocalAdministrativeOrganizationsController {
  constructor(
    private readonly localAdministrativeOrganizationsService: LocalAdministrativeOrganizationsService,
  ) {}

  @Post()
  create(@Body() dto: CreateLocalAdministrativeOrganizationDto) {
    // โค้ดคลีนขึ้นมาก! แค่เรียก service แล้ว return
    return this.localAdministrativeOrganizationsService.create(dto);
  }

  @Get()
  findAll() {
    return this.localAdministrativeOrganizationsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.localAdministrativeOrganizationsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLocalAdministrativeOrganizationDto,
  ) {
    return this.localAdministrativeOrganizationsService.update(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.localAdministrativeOrganizationsService.softRemove(id)
      : this.localAdministrativeOrganizationsService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.localAdministrativeOrganizationsService.restore(id);
  }
}
