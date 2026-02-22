import { Controller, Get, Post, Body, Param, HttpStatus, HttpCode, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';

@Controller({
  path: 'ai-usage-logs',
  version: '1',
})
export class AiUsageLogsController {
  constructor(private readonly aiUsageLogsService: AiUsageLogsService) { }

  @Post()
  async create(@Body() createAiUsageLogDto: CreateAiUsageLogDto): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.create(createAiUsageLogDto);
  }

  @Get()
  async findAll(): Promise<AiUsageLogResponseDto[]> {
    return this.aiUsageLogsService.findAll();
  }

  @Get('stats')
  async getStats(@Query('year') year?: number) {
    return this.aiUsageLogsService.getStats(year);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.findOne(id);
  }
}
