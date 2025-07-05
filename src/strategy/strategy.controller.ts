import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { StrategyService } from './strategy.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'strategy',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(private readonly strategyService: StrategyService) {}

  @Post()
  async create(@Body() dto: CreateStrategyDto) {
    this.logger.log(`Creating strategy: ${dto.stratId}`);
    try {
      return await this.strategyService.create(dto);
    } catch (error) {
      this.logger.error('Error creating strategy', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all strategies');
    try {
      return await this.strategyService.findAll();
    } catch (error) {
      this.logger.error('Error fetching strategies', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching strategy with ID: ${id}`);
    try {
      return await this.strategyService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching strategy ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateStrategyDto) {
    this.logger.log(`Updating strategy with ID: ${id}`);
    try {
      return await this.strategyService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating strategy ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    this.logger.warn(`Removing strategy with ID: ${id}`);
    try {
      return await this.strategyService.remove(id);
    } catch (error) {
      this.logger.error(`Error removing strategy ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  private handleException(error: any) {
    if (
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    ) {
      return error;
    }
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
