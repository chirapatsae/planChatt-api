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
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { StrategyService } from './strategy.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'strategy',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(private readonly strategyService: StrategyService) { }

  @Post()
  create(@Body() dto: CreateStrategyDto , @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log(`Request to create strategy with ID: ${dto.stratId}`);
    return this.strategyService.create(dto , req.user.userId);
  }

  @Get()
  findAll() {
    this.logger.log('Request to fetch all strategies');
    return this.strategyService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    this.logger.log(`Request to fetch strategy with ID: ${id}`);
    return this.strategyService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStrategyDto,
  ) {
    this.logger.log(`Request to update strategy with ID: ${id}`);
    return this.strategyService.update(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser }
  ) {
    return mode === 'soft'
      ? this.strategyService.softRemove(id , req.user.userId)
      : this.strategyService.remove(id );
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.strategyService.restore(id);
  }
}