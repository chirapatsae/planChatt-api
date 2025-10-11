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
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateRevisedProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating revised project group by user ${userId}`);
    return this.revisedProjectGroupService.create(createDto, userId);
  }

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
   * ดึงโครงการทั้งหมดจาก developmentPlanRevision ตัวล่าสุด
   * สำหรับหน้าติดตามโครงการที่ถูกขอแก้ไข/เปลี่ยนแปลง
   */
  @Get('tracking/latest')
  async findLatestRevisionProjects() {
    this.logger.log('Fetching all projects from latest revision');
    return this.revisedProjectGroupService.findLatestRevisionProjects();
  }

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

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching revised project group with id: ${id}`);
    return this.revisedProjectGroupService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateRevisedProjectGroupDto,
  ) {
    this.logger.log(`Updating revised project group with id: ${id}`);
    return this.revisedProjectGroupService.update(id, updateDto);
  }

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

  @Patch(':id/restore')
  async restore(@Param('id') id: string) {
    this.logger.log(`Restoring revised project group with id: ${id}`);
    return this.revisedProjectGroupService.restore(id);
  }
}
