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
import { CreateAiUsageQuotaDto } from './dto/create-ai-usage-quota.dto';
import { UpdateAiUsageQuotaDto } from './dto/update-ai-usage-quota.dto';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'ai-usage-quotas',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class AiUsageQuotasController {
  private readonly logger = new Logger(AiUsageQuotasController.name);

  constructor(private readonly aiUsageQuotasService: AiUsageQuotasService) {}

  @Post()
  create(
    @Body() dto: CreateAiUsageQuotaDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to create AI usage quota for user: ${req.user.userId}`);
    return this.aiUsageQuotasService.create(dto, req.user.userId);
  }

  @Get()
  findAll() {
    this.logger.log('Request to fetch all AI usage quotas');
    return this.aiUsageQuotasService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to fetch AI usage quota with ID: ${id}`);
    return this.aiUsageQuotasService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string, 
    @Body() dto: UpdateAiUsageQuotaDto
  ) {
    this.logger.log(`Request to update AI usage quota with ID: ${id}`);
    return this.aiUsageQuotasService.update(id, dto);
  }

  @Patch(':id/increment-usage')
  incrementUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('amount') amount: string = '1',
  ) {
    const usageAmount = parseInt(amount, 10);
    this.logger.log(`Request to increment usage for AI usage quota with ID: ${id} by ${usageAmount}`);
    return this.aiUsageQuotasService.incrementUsage(id, usageAmount);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    this.logger.log(`Request to remove AI usage quota with ID: ${id} in ${mode} mode`);
    return mode === 'soft'
      ? this.aiUsageQuotasService.softRemove(id)
      : this.aiUsageQuotasService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to restore AI usage quota with ID: ${id}`);
    return this.aiUsageQuotasService.restore(id);
  }
}
