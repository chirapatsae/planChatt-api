import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  UseGuards,
  Patch,
  Delete,
  Query,
  Req,
} from '@nestjs/common';
import { PlanService } from './plan.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'plans',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class PlanController {
  private readonly logger = new Logger(PlanController.name);

  constructor(private readonly planService: PlanService) {}

  @Get()
  async findAll() {
    try {
      return await this.planService.findAll();
    } catch (error) {
      this.logger.error('Error fetching all plans', error.stack);
      throw new InternalServerErrorException('Failed to fetch plans');
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      return await this.planService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching plan ${id}`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to fetch plan');
    }
  }

  @Post()
  create(
    @Body() createPlanDto: CreatePlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.planService.create(createPlanDto, req.user.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePlanDto: UpdatePlanDto) {
    return this.planService.update(id, updatePlanDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return mode === 'soft'
      ? this.planService.softRemove(id, req.user.userId)
      : this.planService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.planService.restore(id);
  }
}
