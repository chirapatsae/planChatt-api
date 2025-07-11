import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  ParseUUIDPipe,
  UseGuards,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { AmphoesService } from './amphoes.service';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'amphoes',
  version: '1',
})
// @UseGuards(JwtAuthGuard)
export class AmphoesController {
  private readonly logger = new Logger(AmphoesController.name);
  constructor(private readonly amphoesService: AmphoesService) { }

  @Post()
  async create(@Body() createAmphoeDto: CreateAmphoeDto) {
    this.logger.log(`Creating amphoe: ${createAmphoeDto.code}`);
    try {
      return await this.amphoesService.create(createAmphoeDto);
    } catch (error) {
      this.logger.error('Error creating amphoe', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all amphoes');
    try {
      return await this.amphoesService.findAll();
    } catch (error) {
      this.logger.error('Error fetching amphoes', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching amphoe with id: ${id}`);
    try {
      return await this.amphoesService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching amphoe ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateAmphoeDto: UpdateAmphoeDto,
  ) {
    this.logger.log(`Updating amphoe with id: ${id}`);
    try {
      return await this.amphoesService.update(id, updateAmphoeDto);
    } catch (error) {
      this.logger.error(`Error updating amphoe ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    const action = mode === 'soft' ? 'Soft removing' : 'Hard removing';
    this.logger.warn(`${action} amphoes ${id}`);
    try {
      return mode === 'soft'
        ? await this.amphoesService.softRemove(id)
        : await this.amphoesService.remove(id);
    } catch (error) {
      this.logger.error(`Error ${action.toLowerCase()} user ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  async restore(@Param('id') id: string) {
    this.logger.log(`Restoring amphoe with id: ${id}`);
    try {
      return await this.amphoesService.restore(id);
    } catch (error) {
      this.logger.error(`Error restoring amphoe ${id}`, error.stack);
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
