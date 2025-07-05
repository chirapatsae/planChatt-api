import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';
import { CreateLocalAdministrativeOrganizationDto } from './dto/create-local-administrative-organization.dto';
import { UpdateLocalAdministrativeOrganizationDto } from './dto/update-local-administrative-organization.dto';
import { ParseUUIDPipe } from '@nestjs/common';

@Controller({
  path: 'local-administrative-organizations',
  version: '1',
})
export class LocalAdministrativeOrganizationsController {
  private readonly logger = new Logger(LocalAdministrativeOrganizationsController.name);

  constructor(
    private readonly localAdministrativeOrganizationsService: LocalAdministrativeOrganizationsService,
  ) {}

  @Post()
  async create(@Body() dto: CreateLocalAdministrativeOrganizationDto) {
    this.logger.log(`Creating LAO with code: ${dto.code}`);
    try {
      return await this.localAdministrativeOrganizationsService.create(dto);
    } catch (error) {
      this.logger.error('Error creating LAO', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all LAOs');
    return this.localAdministrativeOrganizationsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    this.logger.log(`Fetching LAO with id: ${id}`);
    try {
      return await this.localAdministrativeOrganizationsService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching LAO ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLocalAdministrativeOrganizationDto,
  ) {
    this.logger.log(`Updating LAO id: ${id}`);
    try {
      return await this.localAdministrativeOrganizationsService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating LAO ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    this.logger.warn(`Deleting LAO id: ${id}`);
    try {
      return await this.localAdministrativeOrganizationsService.remove(id);
    } catch (error) {
      this.logger.error(`Error deleting LAO ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id/soft-remove')
  async softRemove(@Param('id', new ParseUUIDPipe()) id: string) {
    this.logger.warn(`Soft Deleting LAO id: ${id}`);
    try {
      return await this.localAdministrativeOrganizationsService.softRemove(id);
    } catch (error) {
      this.logger.error(`Error soft deleting LAO ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  async restore(@Param('id', new ParseUUIDPipe()) id: string) {
    this.logger.log(`Restoring LAO id: ${id}`);
    try {
      return await this.localAdministrativeOrganizationsService.restore(id);
    } catch (error) {
      this.logger.error(`Error restoring LAO ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  private handleException(error: any) {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      return error;
    }

    if (typeof error.message === 'string') {
      return new BadRequestException(error.message);
    }

    return new InternalServerErrorException('Unexpected error occurred');
  }
}
