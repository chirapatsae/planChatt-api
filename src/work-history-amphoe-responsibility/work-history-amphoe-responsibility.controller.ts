import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import { UpdateWorkHistoryAmphoeResponsibilityDto, TransferResponsibilityDto } from './dto/update-work-history-amphoe-responsibility.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwtPayloadUser } from '../auth/jwt.strategy';

@Controller({
  path: 'work-history-amphoe-responsibility',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class WorkHistoryAmphoeResponsibilityController {
  constructor(private readonly workHistoryAmphoeResponsibilityService: WorkHistoryAmphoeResponsibilityService) {}

  @Post()
  create(
    @Body() dto: CreateWorkHistoryAmphoeResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryAmphoeResponsibilityService.create(dto, req.user.userId);
  }

  @Get()
  findAll(
    @Query('amphoe') amphoe?: string,
    @Query('workHistory') workHistory?: string,
  ) {
    return this.workHistoryAmphoeResponsibilityService.findAll(amphoe , workHistory);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryAmphoeResponsibilityService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkHistoryAmphoeResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryAmphoeResponsibilityService.update(id, dto , req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryAmphoeResponsibilityService.remove(id);
  }




}
