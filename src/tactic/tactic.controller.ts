import {
  Controller,
  Get,
  Param,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { TacticService } from './tactic.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'tactic',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class TacticController {
  private readonly logger = new Logger(TacticController.name);

  constructor(private readonly tacticService: TacticService) {}

  @Get()
  async findAll() {
    this.logger.log('GET /tactic');
    try {
      return await this.tacticService.findAll();
    } catch (error) {
      this.logger.error('Error in GET /tactic', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`GET /tactic/${id}`);
    try {
      return await this.tacticService.findOne(id);
    } catch (error) {
      this.logger.error(`Error in GET /tactic/${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  private handleException(error: any) {
    if (
      error instanceof NotFoundException ||
      error instanceof InternalServerErrorException
    ) {
      return error;
    }
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
