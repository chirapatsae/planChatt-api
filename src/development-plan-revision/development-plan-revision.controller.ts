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
import { DevelopmentPlanRevisionService } from './development-plan-revision.service';
import { CreateDevelopmentPlanRevisionDto, GenerateApprovedBookForEditRevisionDto } from './dto/create-development-plan-revision.dto';
import { UpdateDevelopmentPlanRevisionDto } from './dto/update-development-plan-revision.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { UpdateDevelopmentPlanRevisionOpenStateDto } from './dto/update-development-plan-revision-open-state.dto';
import { DeleteDevelopmentPlanDto } from 'src/development-plan/dto/delete-development-plan.dto';

@Controller({ path: 'development-plan-revision', version: '1' })
@UseGuards(JwtAuthGuard)
export class DevelopmentPlanRevisionController {
  private readonly logger = new Logger(DevelopmentPlanRevisionController.name);

  constructor(
    private readonly developmentPlanRevisionService: DevelopmentPlanRevisionService,
  ) {}

  // ============================================
  // 🟢 Create & Read
  // ============================================

  @Post()
  async create(
    @Body() createDto: CreateDevelopmentPlanRevisionDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating development plan revision by user ${userId}`);
    return this.developmentPlanRevisionService.create(createDto, userId);
  }

  @Get()
  async findAll(@Query('developmentPlanId') developmentPlanId?: string) {
    if (developmentPlanId) {
      return this.developmentPlanRevisionService.findByDevelopmentPlan(developmentPlanId);
    }
    this.logger.log('Fetching all development plan revisions');
    return this.developmentPlanRevisionService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.findOne(id);
  }

  // ============================================
  // 🟡 Update
  // ============================================

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateDevelopmentPlanRevisionDto,
  ) {
    this.logger.log(`Updating development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.update(id, updateDto);
  }

  @Patch(':id/open-state')
  async updateOpenState(
    @Param('id') id: string,
    @Body() dto: UpdateDevelopmentPlanRevisionOpenStateDto,
  ) {
    this.logger.log(`Updating open state for development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.updateOpenState(id, dto.isOpen);
  }

  // ============================================
  // 🔴 Delete
  // ============================================

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body() deleteDto: DeleteDevelopmentPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Removing development plan revision with id: ${id} by user ${userId}`);
    return this.developmentPlanRevisionService.softRemove(id, userId, deleteDto.citizenIdSuffix);
  }

  // ============================================
  // 📘 Book Generation (สร้างเล่มอนุมัติ) — DEPRECATED
  // ============================================

  /**
   * @deprecated Use the new book assembly flow instead:
   *   POST /book-assembly/edit_revision/{revisionId}/draft → upload parts → POST .../merge
   */
  @Post('edit/book')
  async generateApprovedEditBook(
    @Param('id') id: string,
    @Body() body: GenerateApprovedBookForEditRevisionDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.warn(`DEPRECATED: POST /development-plan-revision/edit/book — use POST /book-assembly/edit_revision/${body.developmentPlanRevisionId}/draft/merge instead`);
    return this.developmentPlanRevisionService.generateApprovedBookForEditRevision(body.developmentPlanRevisionId, userId);
  }

  /**
   * @deprecated Use the new book assembly flow instead:
   *   POST /book-assembly/change_revision/{revisionId}/draft → upload parts → POST .../merge
   */
  @Post('change/book')
  async generateApprovedChangeBook(
    @Param('id') id: string,
    @Body() body: GenerateApprovedBookForEditRevisionDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.warn(`DEPRECATED: POST /development-plan-revision/change/book — use POST /book-assembly/change_revision/${body.developmentPlanRevisionId}/draft/merge instead`);
    return this.developmentPlanRevisionService.generateApprovedBookForChangeRevision(body.developmentPlanRevisionId, userId);
  }

  /**
   * @deprecated Use the new book assembly flow instead:
   *   POST /book-assembly/{edit_revision|change_revision}/{id}/cancel
   */
  @Post(':id/rollback-book')
  async rollbackBook(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.warn(`DEPRECATED: POST /development-plan-revision/${id}/rollback-book — use POST /book-assembly/{sourceType}/${id}/cancel instead`);
    return this.developmentPlanRevisionService.rollbackBook(id, userId);
  }
}
