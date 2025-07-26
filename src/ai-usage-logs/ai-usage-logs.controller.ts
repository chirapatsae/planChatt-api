import { Controller, Get, Post, Body, Param, HttpStatus, HttpCode } from '@nestjs/common';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';

@Controller('ai-usage-logs')
export class AiUsageLogsController {
  constructor(private readonly aiUsageLogsService: AiUsageLogsService) {}

  @Post()
  async create(@Body() createAiUsageLogDto: CreateAiUsageLogDto): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.create(createAiUsageLogDto);
  }

  @Get()
  async findAll(): Promise<AiUsageLogResponseDto[]> {
    return this.aiUsageLogsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.findOne(id);
  }
}
