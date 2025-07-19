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
  ParseUUIDPipe,
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

  constructor(private readonly strategyService: StrategyService) { }

  @Post()
  create(@Body() dto: CreateStrategyDto) {
    this.logger.log(`Request to create strategy with ID: ${dto.stratId}`);
    return this.strategyService.create(dto);
  }

  @Get()
  findAll() {
    this.logger.log('Request to fetch all strategies');
    return this.strategyService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to fetch strategy with ID: ${id}`);
    return this.strategyService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStrategyDto,
  ) {
    this.logger.log(`Request to update strategy with ID: ${id}`);
    return this.strategyService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Request to remove strategy with ID: ${id}`);
    return this.strategyService.remove(id);
  }
}