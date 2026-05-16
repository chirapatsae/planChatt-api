import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  ParseUUIDPipe,
  Req,
  Logger,
  Res,
  Delete,
  Query,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request, Response } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { AttachmentSupplementProjectGroupsService } from './attachment-supplement-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';
// SUPP_AI_BE_02 — SPG attachment AI analyze endpoint. Mirrors the PG /
// RPG controllers byte-for-byte; delegates to the shared
// `DocumentAnalysisService` using the `'supplement-project-group'` kind
// (added by SUPP_AI_BE_01).
import { DocumentAnalysisService } from 'src/document-analysis/document-analysis.service';
// Pre-call quota enforcement for the staff-lead retry endpoint. Mirrors
// the PG / RPG retry guard — analysis triggered here calls OpenAI
// (summary) so the retry MUST be gated by the user-quota + org-cap
// pre-call guard.
import { AiQuotaGuard } from 'src/ai-usage-quotas/guards/ai-quota.guard';
import { AiQuotaWeight } from 'src/ai-usage-quotas/decorators/ai-quota-weight.decorator';

const STAFF_LEAD_ROLES = new Set(['staff', 'admin', 'super-admin']);

/**
 * SUPP-3 / BE-07 — Attachment endpoints for `SupplementProjectGroup`.
 *
 * URL conventions mirror `attachment-project-groups` /
 * `attachment-revised-project-groups` byte-for-byte (modulo the noun).
 *
 * Owner-scoped routes (`POST upload/:spgId`, `DELETE :id`) enforce the
 * §1+§2 supplement owner gate inside the service layer
 * (`SupplementScopeService.assertSupplementOwnerScope`). Staff /
 * admin / super-admin read routes (download, signed-url, public/list)
 * follow the PG pattern: `JwtAuthGuard` only, no role narrowing — the
 * supplement workflow doc §13 keeps staff routing in the SPG service
 * itself; attachment reads are not gated further.
 *
 * AI analysis (SUPP_AI_BE_02): `GET :id/analysis` (read) and
 * `POST :id/analysis/retry` (staff-lead retry) follow the PG / RPG
 * pattern verbatim. They delegate to `DocumentAnalysisService` with
 * kind `'supplement-project-group'` (added by SUPP_AI_BE_01). The retry
 * route is advisory per §17.2 — it never alters workflow state.
 */
@Controller({
  path: 'attachment-supplement-project-groups',
  version: '1',
})
export class AttachmentSupplementProjectGroupsController {
  private readonly logger = new Logger(
    AttachmentSupplementProjectGroupsController.name,
  );

  constructor(
    private readonly attachmentService: AttachmentSupplementProjectGroupsService,
    private readonly documentAnalysisService: DocumentAnalysisService,
  ) {}

  // Public file viewing endpoint with URL signing.
  @Get('public/:id')
  async viewFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') signedToken: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Viewing SPG file with ID: ${id} with signed token`);

    if (!signedToken || !UrlSigningUtil.validateSignedToken(id, signedToken)) {
      this.logger.warn(
        `Invalid or missing signed token for SPG file ID: ${id}`,
      );
      throw new UnauthorizedException('Token ไม่ถูกต้องหรือหมดอายุ');
    }

    return this.attachmentService.viewFile(id, res);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/signed-url')
  async generateSignedUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Generating signed URL for SPG file ID: ${id} by user: ${req.user.userId}`,
    );

    const fileExists = await this.attachmentService.fileExists(id);
    if (!fileExists) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    const baseUrl = `${process.env.APP_URL}/api/v1/attachment-supplement-project-groups/public/${id}`;
    const signedUrl = UrlSigningUtil.generateSignedUrl(baseUrl, id);

    return {
      signedUrl,
      expiresIn: '24 hours',
      fileId: id,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload/:supplementProjectGroupId')
  @UseInterceptors(FilesInterceptor('files', 10, multerConfig))
  async uploadFiles(
    @Param('supplementProjectGroupId', ParseUUIDPipe)
    supplementProjectGroupId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Uploading ${files.length} files for supplementProjectGroup: ${supplementProjectGroupId} by user: ${req.user.userId}`,
    );

    // Fix UTF-8 encoding for filenames (multer reads as latin1 from the
    // multipart form). Mirrors the PG / RPG behavior.
    const fixedFiles = files.map((file) => {
      const originalName = file.originalname;
      const fixedName = Buffer.from(originalName, 'latin1').toString('utf8');
      return {
        ...file,
        originalname: fixedName,
      };
    });

    return this.attachmentService.uploadMultipleFiles(
      fixedFiles,
      supplementProjectGroupId,
      req.user.userId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('supplement-project-group/:supplementProjectGroupId')
  async findBySupplementProjectGroup(
    @Param('supplementProjectGroupId', ParseUUIDPipe)
    supplementProjectGroupId: string,
  ) {
    return this.attachmentService.findBySupplementProjectGroupId(
      supplementProjectGroupId,
    );
  }

  // AI analysis — read current status + summary. Mirrors the PG / RPG
  // `GET :id/analysis` route byte-for-byte. Advisory only per §17.2.
  @UseGuards(JwtAuthGuard)
  @Get(':id/analysis')
  async getAnalysis(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.documentAnalysisService.getAnalysis(
      'supplement-project-group',
      id,
    );
    if (!result) {
      throw new NotFoundException(`Attachment with ID ${id} not found`);
    }
    return result;
  }

  // AI analysis — staff-lead retry for failed rows. Mirrors the PG /
  // RPG `POST :id/analysis/retry` route byte-for-byte. The §17.8
  // cooldown key `(actor × target × endpoint_key)` is target-kind
  // agnostic — the cooldown bucket is keyed by `target_id` (the
  // attachment UUID), which is unique across PG / RPG / SPG, so SPG
  // joins the bucket without any cooldown-key extension.
  @UseGuards(JwtAuthGuard, AiQuotaGuard)
  @AiQuotaWeight('document-summary')
  @Post(':id/analysis/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!STAFF_LEAD_ROLES.has(req.user.role)) {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่สามารถสั่งวิเคราะห์ใหม่ได้',
      );
    }
    await this.documentAnalysisService.retry(
      'supplement-project-group',
      id,
      req.user.userId,
    );
    return { status: 'processing', attachmentId: id };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.attachmentService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async downloadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    await this.attachmentService.downloadFile(id, res);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    await this.attachmentService.remove(id, req.user.userId);
    return { message: 'File deleted successfully' };
  }
}
