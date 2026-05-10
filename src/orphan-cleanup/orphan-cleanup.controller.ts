import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { OrphanCleanupService } from './orphan-cleanup.service';
import {
  PreviewCleanupQueryDto,
  PreviewCleanupResponseDto,
} from './dto/preview-cleanup.dto';

/**
 * W110-BE-01 — Read-only preview endpoint consumed by the FE-01
 * confirmation modal.
 *
 * Authority mirrors the host book operation — `admin` and `super-admin`
 * only. There is NO mutation surface in this controller; the cascade only
 * runs as a transactional side-effect of the existing book softRemove /
 * finalize flows (CLAUDE.md §18 + workflow doc Trigger Surfaces).
 */
@Controller({ path: 'book-cleanup', version: '1' })
@UseGuards(JwtAuthGuard)
export class OrphanCleanupController {
  private readonly logger = new Logger(OrphanCleanupController.name);

  constructor(
    private readonly orphanCleanupService: OrphanCleanupService,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  @Get('preview')
  async preview(
    @Query() query: PreviewCleanupQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<PreviewCleanupResponseDto> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('ผู้ใช้งานไม่ผ่านการตรวจสอบสิทธิ์');
    }

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus'],
    });
    if (!workHistory) {
      throw new UnauthorizedException('ไม่พบข้อมูลการทำงานปัจจุบันของผู้ใช้');
    }
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }
    const allowedRoles = new Set(['admin', 'super-admin']);
    const roleName = workHistory.role?.name ?? '';
    if (!allowedRoles.has(roleName)) {
      throw new ForbiddenException(
        'เฉพาะผู้ดูแลระบบ (admin / super-admin) เท่านั้นที่สามารถดูตัวอย่างการล้างโครงการคงค้างได้',
      );
    }

    return this.orphanCleanupService.previewBookCleanup(
      query.bookId,
      query.bookKind,
      query.kind,
    );
  }
}
