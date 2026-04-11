import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Logger,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { RevisedProjectGroupService } from './revised-project-group.service';
import { CreateRevisedProjectGroupDto } from './dto/create-revised-project-group.dto';
import { UpdateRevisedProjectGroupDto } from './dto/update-revised-project-group.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'revised-project-group', version: '1' })
@UseGuards(JwtAuthGuard)
export class RevisedProjectGroupController {
  private readonly logger = new Logger(RevisedProjectGroupController.name);

  constructor(
    private readonly revisedProjectGroupService: RevisedProjectGroupService,
  ) { }

  // ========================================
  // CRUD Operations (Basic)
  // ========================================

  /**
   * สร้าง RevisedProjectGroup ใหม่
   */
  @Post()
  async create(
    @Body() createDto: CreateRevisedProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating revised project group by user ${userId}`);
    return this.revisedProjectGroupService.create(createDto, userId);
  }

  /**
   * ดึง RevisedProjectGroup ทั้งหมด
   * @param revisionId - (optional) กรองตาม revision ID
   */
  @Get()
  async findAll(@Query('revisionId') revisionId?: string) {
    if (revisionId) {
      this.logger.log(
        `Fetching revised project groups for revision: ${revisionId}`,
      );
      return this.revisedProjectGroupService.findByRevision(revisionId);
    }
    this.logger.log('Fetching all revised project groups');
    return this.revisedProjectGroupService.findAll();
  }

  /**
   * ดึง RevisedProjectGroup ที่เป็น revision ล่าสุดของแต่ละ ProjectGroup
   * แสดงเฉพาะจากตาราง revised-project-group (ไม่รวม original projects)
   * @param developmentPlanId - ID ของ DevelopmentPlan (required)
   * @param revisionId - (optional) ID ของ DevelopmentPlanRevision
   * @param countOnly - (optional) ถ้าเป็น true จะ return จำนวนโครงการแทน array
   */
  @Get('latest-only')
  async findLatestRevisedProjectsOnly(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('revisionId') revisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true' || countOnly === '1';
    const userId = req.user?.userId;
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}latest revised project groups only - developmentPlanId: ${developmentPlanId}, revisionId: ${revisionId}, userId: ${userId}`,
    );
    return this.revisedProjectGroupService.findLatestRevisedProjectsOnly({
      userId,
      developmentPlanId,
      revisionId,
      countOnly: shouldCount,
    });
  }

  /**
   * ดึง RevisedProjectGroup ตาม ID
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching revised project group with id: ${id}`);
    return this.revisedProjectGroupService.findOne(id);
  }

  /**
   * เปลี่ยนแปลง DevelopmentPlanRevisionID ของ RevisedProjectGroup (Optimized)
   */
  @Patch('change/developmentPlanRevision/:id')
  async updateChangeDevelopmentPlanRevision(
    @Param('id') id: string,
    @Body('developmentPlanRevisionId') developmentPlanRevisionId: string,
  ) {
    this.logger.log(
      `Updating revision ID for revised project group with id: ${id}`,
    );
    return this.revisedProjectGroupService.updateChangeDevelopmentPlanRevision(
      id,
      developmentPlanRevisionId,
    );
  }

  /**
   * ดูประวัติการแก้ไขทั้งหมดของโครงการ (Original + All Revisions)
   */
  @Get(':id/versions')
  async findAllVersions(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Fetching all versions for project with id: ${id}`);
    return this.revisedProjectGroupService.findAllVersions(id, req.user.userId);
  }
  /**
   * อัพเดท RevisedProjectGroup
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateRevisedProjectGroupDto,
  ) {
    this.logger.log(`Updating revised project group with id: ${id}`);
    return this.revisedProjectGroupService.update(id, updateDto);
  }


  /**
   * ลบ RevisedProjectGroup
   * @param mode - 'soft' (default) หรือ 'hard'
   */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    this.logger.log(`Removing revised project group with id: ${id}, mode: ${mode}`);
    return mode === 'soft'
      ? this.revisedProjectGroupService.softRemove(id)
      : this.revisedProjectGroupService.remove(id);
  }

  /**
   * คืนค่า RevisedProjectGroup ที่ถูกลบแบบ soft delete
   */
  @Patch(':id/restore')
  async restore(@Param('id') id: string) {
    this.logger.log(`Restoring revised project group with id: ${id}`);
    return this.revisedProjectGroupService.restore(id);
  }

  // ========================================
  // Tracking Operations
  // ========================================

  /**
   * ดึงโครงการทั้งหมดจาก developmentPlanRevision ตัวล่าสุด
   * สำหรับหน้าติดตามโครงการที่ถูกขอแก้ไข/เปลี่ยนแปลง
   */
  @Get('tracking/latest')
  async findLatestRevisionProjects() {
    this.logger.log('Fetching all projects from latest revision');
    return this.revisedProjectGroupService.findLatestRevisionProjects();
  }

  // ========================================
  // Tracking Operations - ประเภท "แก้ไข"
  // ========================================

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Pending"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/edit/pending')
  async findPendingRevisionProjects(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId', ParseUUIDPipe) developmentPlanId?: string,
    @Query('developmentPlanRevisionId', ParseUUIDPipe) developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    const userId = req.user?.userId;
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}pending revision projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}, userId: ${userId}`,
    );

    const result = await this.revisedProjectGroupService.findPendingRevisionProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
      userId,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Verified"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/edit/verify')
  async findVerifyRevisionProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}verify revision projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findVerifyRevisionProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
 * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Revision "
 * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
 * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
 * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
 */
  @Get('tracking/edit/revision')
  async findRevisionProjects(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId', ParseUUIDPipe) developmentPlanId?: string,
    @Query('developmentPlanRevisionId', ParseUUIDPipe) developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    const userId = req.user?.userId;
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}revised revision projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}, userId: ${userId}`,
    );

    const result = await this.revisedProjectGroupService.findRevisionProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
      userId,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    // CLAUDE.md §14 — the service already performs a batched descendant
    // lookup and decorates each entity with `hasDescendant` (see
    // RevisedProjectGroupService.findRevisionProjects). Propagate that flag
    // through the unified DTO so FE-LOCK-06 can disable edit/delete in the
    // EditRevision wizard. Do NOT revert to `mapMany` — it drops the flag.
    return (result as any[]).map((r) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(r, r.hasDescendant === true),
    );
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Pending Approval"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/edit/pending-approval')
  async findVerifyPendingApprovalProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}Pending Approval revision projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findVerifyPendingApprovalProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Approved"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/edit/approved')
  async findApprovedProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}Approved revision projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findApprovedProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  // ========================================
  // Tracking Operations - ประเภท "เปลี่ยนแปลง"
  // ========================================

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Pending"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/change/pending')
  async findPendingSupplementProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}pending supplement projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findPendingSupplementProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Verified"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/change/verify')
  async findVerifySupplementProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}verify supplement projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findVerifySupplementProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Pending Approval"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/change/pending-approval')
  async findVerifyPendingApprovalSupplementProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}Pending Approval supplement projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findVerifyPendingApprovalSupplementProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Approved"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   */
  @Get('tracking/change/approved')
  async findApprovedSupplementProjects(
    @Query('developmentPlanId') developmentPlanId?: string,
    @Query('developmentPlanRevisionId') developmentPlanRevisionId?: string,
    @Query('countOnly') countOnly?: string,
  ) {
    const shouldCount = countOnly === 'true';
    this.logger.log(
      `Fetching ${shouldCount ? 'count of ' : ''}Approved supplement projects - developmentPlanId: ${developmentPlanId}, developmentPlanRevisionId: ${developmentPlanRevisionId}`,
    );

    const result = await this.revisedProjectGroupService.findApprovedSupplementProjects(
      developmentPlanId,
      developmentPlanRevisionId,
      shouldCount,
    );

    if (shouldCount) {
      return { count: result as number };
    }

    return result;
  }

  // ========================================
  // Tracking Operations - อื่นๆ
  // ========================================

  /**
   * แสดงรายละเอียดโครงการพร้อมเปรียบเทียบข้อมูลเดิม
   * - ถ้า revisionNumber = 1 → เทียบกับ ProjectGroup (เล่มแม่)
   * - ถ้า revisionNumber > 1 → เทียบกับ RevisedProjectGroup จาก revision ก่อนหน้า
   */
  @Get('tracking/:id/comparison')
  async findProjectComparison(@Param('id') id: string) {
    this.logger.log(`Fetching project comparison for id: ${id}`);
    return this.revisedProjectGroupService.findProjectComparison(id);
  }
}
