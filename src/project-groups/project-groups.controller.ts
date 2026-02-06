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
  ValidationPipe,
} from '@nestjs/common';
import { ProjectGroupsService } from './project-groups.service';
import { CreateDraftProjectGroupDto, CreateProjectGroupDto } from './dto/create-project-group.dto';
import { BulkAssignAgencyDto, BulkAssignAgencyDtoArray, UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'project-groups',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProjectGroupsController {
  constructor(private readonly projectGroupsService: ProjectGroupsService) { }

  // ===================================================================
  // 📝 CREATE Operations
  // ===================================================================

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

  // ===================================================================
  // 📖 READ Operations
  // ===================================================================

  // --- Find by Status (General) ---
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

  // --- Find by Status (Pending/Review) ---
  // รอตรวจสอบ - ประสานแผน
  @Get('/by-status-pending-coordinate')
  async findByStatusPendingCoordinate(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusPendingCoordinate({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // รอตรวจสอบ - ส่วนราชการภายใน
  @Get('/by-status-pending-agency')
  async findByStatusPendingAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusPendingAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // รอการอนุมัติ - ประสานแผน
  @Get('/by-status-pending-approval-coordinate')
  async findByStatusProvincialCommittee(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusProvincialCommittee({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // รอการอนุมัติ - ส่วนราชการภายใน
  @Get('/by-status-pending-approval')
  async findByStatusPlanCommittee(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusPlanCommittee({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // --- Find by Status (Verified/Authority) ---
  // ผ่านการตรวจสอบ - ส่วนราชการภายใน
  @Get('/by-status-verified-agency')
  async findByStatusVerifiedAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusVerifiedAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // อยู่ในอำนาจ
  @Get('/by-status-authority')
  async findByStatusInAuthority(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findProjectsByStatusInAuthority({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // อยู่นอกอำนาจ
  @Get('/by-status-authority-out')
  async findByStatusInAuthorityOut(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findProjectsByStatusInAuthorityOut({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // --- Find by Status (Approved) ---
  // โครงการที่ผ่านการอนุมัติ - ประสานแผน
  @Get('/by-status-approved-coordinate')
  async findByStatusApprovedCoordinate(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusApprovedCoordinate({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // โครงการที่ผ่านการอนุมัติ - ส่วนราชการภายใน
  @Get('/by-status-approved-agency')
  async findByStatusApprovedAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findByStatusApprovedAgency({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // โครงการที่ผ่านการอนุมัติ (ทั่วไป)
  @Get('/by-status-approved')
  async findByStatusApproved(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
    @Query('filterByResponsibleAgency') filterByResponsibleAgency?: string,
  ) {
    return this.projectGroupsService.findByStatusApproved({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
      filterByResponsibleAgency: filterByResponsibleAgency === 'true' || filterByResponsibleAgency === '1',
    });
  }

  // --- Find Latest All ---
  @Get('/latest-all')
  async findLatestAllProjects(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findLatestAllProjects({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  // --- Find Latest All (เฉพาะ role user ตาม agency/localOrg ) ---
  @Get('/latest-all-by-agency')
  async findLatestAllProjectsByAgency(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findLatestAllProjectsByUserAllPlans({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }
  // --- Find Latest All ---
  @Get('/latest-all-status')
  async findLatestAllProjectsStatus(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findLatestAllProjectsStatus({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  @Get('/latest-all-approved')
  async findLatestAllProjectsApproved(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('countOnly') countOnly?: string,
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true })) developmentPlanId?: string,
  ) {
    return this.projectGroupsService.findLatestAllProjectsApproved({
      userId: req.user.userId,
      countOnly: countOnly === 'true' || countOnly === '1',
      developmentPlanId,
    });
  }

  @Get('/out-authority/by-pdf/:id')
  async findByPdf(
    @Req() req: Request & { user: JwtPayloadUser },
    @Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.findOutAuthorityByPdf({id  , userId : req.user.userId});
  }

  // --- Executive Dashboard/Analysis ---
  @Get('executive/strategies')
  async findExecutiveStrategies(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findExecutiveStrategies(req.user.userId);
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

  // --- Other Queries ---
  @Get('delete')
  async findDelete(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDelete(req.user.userId);
  }

  // --- Find by ID (ต้องอยู่ท้ายสุด เพื่อไม่ให้ match route ที่ specific) ---
  @Get(':id/versions')
  async findAllVersions(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.findAllVersions(id, req.user.userId);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
     
    return this.projectGroupsService.findOne(id , req.user.userId);
  }

  // ===================================================================
  // ✏️ UPDATE Operations
  // ===================================================================

  @Patch('bulk-assign-agency')
  async bulkAssignAgency(
    @Body(new ValidationPipe({ 
      transform: true,
      whitelist: false, // Allow array directly
      forbidNonWhitelisted: false // Don't forbid array structure
    })) dto: BulkAssignAgencyDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    console.log('bulkAssignAgency', dto);
    return this.projectGroupsService.bulkAssignAgency(dto, req.user.userId);
  }

  @Patch('draft/:id')
  async updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDraftProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.updateDraft(id, dto, req.user.userId);
  }

  @Patch('draft/:id/simple-publish')
  async simplePublishDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.simplePublish(id, req.user.userId);
  }

  @Patch('draft/:id/publish')
  async publishDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.publishDraft(id, dto, req.user.userId);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.projectGroupsService.update(id, dto, req.user.userId);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.restore(id);
  }

  // ===================================================================
  // 🗑️ DELETE Operations
  // ===================================================================

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.projectGroupsService.softRemove(id)
      : this.projectGroupsService.remove(id);
  }

  @Delete('deleted/purge')
  async purgeDeletedProjects() {
    return this.projectGroupsService.handleProjectCleanUp();
  }
}
