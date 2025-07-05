import { Controller, Get, Post, Body, Patch, Param, Delete, Logger, BadRequestException, InternalServerErrorException, ParseUUIDPipe } from '@nestjs/common';
import { StatusService } from './status.service';
import { CreateStatusDto } from './dto/create-status.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

@Controller({
  path: 'status',
  version: '1'
})
export class StatusController {
  private readonly logger = new Logger(StatusController.name);
  constructor(private readonly statusService: StatusService) { }

  @Post()
  create(@Body() createStatusDto: CreateStatusDto) {
    this.logger.log(`Creating status: ${createStatusDto}`);
    try {
      return this.statusService.create(createStatusDto);
    } catch (error) {
      this.logger.error('Error creating status', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all status');
    try {
      return await this.statusService.findAll();
    } catch (error) {
      this.logger.error('Error fetching status', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  findOne(@Param('id' , ParseUUIDPipe ) id: string) {
    this.logger.log('Fetching status with id: ' + id);
    try {
      return this.statusService.findOne(id);
    } catch (error) { 
      this.logger.error(`Error fetching status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  update(@Param('id' , ParseUUIDPipe) id: string, @Body() updateStatusDto: UpdateStatusDto) {
    this.logger.log('Updating status with id: ' + id);
    try{
      return this.statusService.update(id, updateStatusDto);
    } catch (error) {
      this.logger.error(`Error updating status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  restore(@Param('id' , ParseUUIDPipe) id: string) {
    this.logger.log('Restore status with id: ' + id);
    try{
      return this.statusService.restore(id);
    } catch (error) {
      this.logger.error(`Error updating status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id/soft-remove')
  softRemove(@Param('id' , ParseUUIDPipe) id: string) {
    this.logger.log('Deleting status with id: ' + id);
    try {
      return this.statusService.softRemove(id);
    }
    catch (error) {
      this.logger.error(`Error deleting status ${id}`, error.stack);
      throw this.handleException(error);
    } 
  }

  private handleException(error: any) {
    if (error instanceof BadRequestException) {
      return error;
    }
    return new InternalServerErrorException('An unexpected error occurred');
  }
}
