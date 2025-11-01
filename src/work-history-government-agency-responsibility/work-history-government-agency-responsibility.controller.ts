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
import { WorkHistoryGovernmentAgencyResponsibilityService } from './work-history-government-agency-responsibility.service';
import { CreateWorkHistoryGovernmentAgencyResponsibilityDto } from './dto/create-work-history-government-agency-responsibility.dto';
import {
  UpdateWorkHistoryGovernmentAgencyResponsibilityDto,
  TransferResponsibilityDto,
} from './dto/update-work-history-government-agency-responsibility.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwtPayloadUser } from '../auth/jwt.strategy';

@Controller({
  path: 'work-history-government-agency-responsibility',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class WorkHistoryGovernmentAgencyResponsibilityController {
  constructor(
    private readonly workHistoryGovernmentAgencyResponsibilityService: WorkHistoryGovernmentAgencyResponsibilityService,
  ) {}

  @Post()
  create(
    @Body() dto: CreateWorkHistoryGovernmentAgencyResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryGovernmentAgencyResponsibilityService.create(
      dto,
      req.user.userId,
    );
  }

  @Get()
  findAll(
    @Query('governmentAgency') governmentAgency?: string,
    @Query('workHistory') workHistory?: string,
  ) {
    return this.workHistoryGovernmentAgencyResponsibilityService.findAll(
      governmentAgency,
      workHistory,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryGovernmentAgencyResponsibilityService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkHistoryGovernmentAgencyResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryGovernmentAgencyResponsibilityService.update(
      id,
      dto,
      req.user.userId,
    );
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryGovernmentAgencyResponsibilityService.remove(id);
  }
}
