import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ProjectGroupsService } from './project-groups.service';
import { CreateDraftProjectGroupDto, CreateProjectGroupDto } from './dto/create-project-group.dto';
import { BulkAssignAgencyDto, UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'project-groups',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProjectGroupsController {
  constructor(private readonly projectGroupsService: ProjectGroupsService) { }

  @Post()
  async create(
    @Body() dto: CreateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.create(dto, req.user.userId);
  }

  @Post('draft')
  async createDraft(
    @Body() dto: CreateDraftProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.createDraft(dto, req.user.userId);
  }

  @Patch('draft/:id/simple-publish')
  async simplePublishDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.simplePublish(id, req.user.userId);
  }

  @Patch('bulk-assign-agency')
  async bulkAssignAgency(
    @Body() dto: BulkAssignAgencyDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.bulkAssignAgency(dto, req.user.userId);
  }


  @Patch('draft/:id')
  async updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.updateDraft(id, dto, req.user.userId);
  }

  @Patch('draft/:id/publish')
  async publishDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.publishDraft(id, dto, req.user.userId);
  }

  @Get('/by-status')
  async findByStatus(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('type') type: 'draft' | 'ready' | 'pending' | 'edit' | 'verified' | 'approved' | 'rejected' | 'draft-development-plan' | 'provincial-committee',
    @Query('countOnly') countOnly?: string,
    @Query('isCoordinate') isCoordinate?: boolean,

  ) {
    return this.projectGroupsService.findProjectsByStatus({
      userId: req.user.userId,
      type,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }
  //รอตรวจสอบ ประสานแผน
  @Get('/by-status-pending-coordinate')
  async findByStatusPendingCoordinate(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusPendingCoordinate({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }
  //รอตรวจสอบ ส่วนราชการภายใน
  @Get('/by-status-pending-agency')
  async findByStatusPendingAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusPendingAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }
  //นำเข้าคณะกรรมการระดับจังหวัด
  @Get('/by-status-pendding-approval-coordinate')
  async findByStatusProvincialCommittee(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusProvincialCommittee({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }
    //นำเข้าคณะกรรมการพิจารณาแผน
    @Get('/by-status-pending-approval')
    async findByStatusPlanCommittee(
      @Req() req: Request & { user: JwtPayloadUser },
      @Query('countOnly') countOnly?: string,
  
    ) {
      return this.projectGroupsService.findByStatusPlanCommittee({
        userId: req.user.userId,
        countOnly: countOnly === 'true' || countOnly === '1',
      });
    }

  //ผ่านการตรวจสอบ ส่วนราชการภายใน
  @Get('/by-status-verified-agency')
  async findByStatusVerifiedAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusVerifiedAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }

  //อยู่ในอำนาจ
  @Get('/by-status-authority')
  async findByStatusInAuthority(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findProjectsByStatusInAuthority({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }

  //อยู่นอกอำนาจ
  @Get('/by-status-authority-out')
  async findByStatusInAuthorityOut(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findProjectsByStatusInAuthorityOut({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }

  //โครงการประสานที่ผ่านการอนุมัติ
  @Get('/by-status-approved-coordinate')
  async findByStatusApprovedCoordinate(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusApprovedCoordinate({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }
  //โครงการส่วนราชการภายในที่ผ่านการอนุมัติ
  @Get('/by-status-approved-agency')
  async findByStatusApprovedAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,

  ) {
    return this.projectGroupsService.findByStatusApprovedAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }

  @Get('/by-status-approved')
  async findByStatusApproved(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('budgetPlanId' , ParseUUIDPipe) budgetPlanId?: string,
    @Query('filterByResponsibleAgency') filterByResponsibleAgency?: string,
  ) {
    return this.projectGroupsService.findByStatusApproved({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      budgetPlanId,
      filterByResponsibleAgency: filterByResponsibleAgency === 'true' || filterByResponsibleAgency === '1',
    });
  }

  // โครงการล่าสุดทั้งหมด (ไม่กรองสถานะ)
  @Get('/latest-all')
  async findLatestAllProjects(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('budgetPlanId', ParseUUIDPipe) budgetPlanId?: string,
  ) {
    return this.projectGroupsService.findLatestAllProjects({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      budgetPlanId,
    });
  }

  @Get('executive/strategies')
  async findExecutiveStrategies(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutiveStrategies(req.user.userId);
  }

  @Get('delete')
  async findDelete(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDelete(req.user.userId);
  }

  // แสดงประวัติทุก version ของโครงการ
  @Get(':id/versions')
  async findAllVersions(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.findAllVersions(id, req.user.userId);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.findOne(id);
  }

  @Delete('deleted/purge')
  async purgeDeletedProjects() {
    return this.projectGroupsService.handleProjectCleanUp();
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.update(id, dto, req.user.userId);
  }



  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.projectGroupsService.softRemove(id)
      : this.projectGroupsService.remove(id);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.restore(id);
  }

  @Get('/executive/budget')
  async getExecutiveDashboard(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutiveDashboard(req.user.userId);
  }

  @Get('/executive/plan')
  async getExecutivePlanAnalysis(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutivePlanAnalysis(req.user.userId);
  }

  @Get('/executive/map')
  async getExecutiveMapData(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutiveMapData(req.user.userId);
  }

  @Get('/executive/map-district')
  async getExecutiveMapDistrictData(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutiveMapDistrictData(req.user.userId);
  }

}
