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
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request, Response } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { AttachmentRevisedEquipmentProjectGroupsService } from './attachment-revised-equipment-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

/**
 * Wave Equipment Revision Management — attachment support for RELPG.
 *
 * REST surface mirror of `AttachmentRevisedProjectGroupsController`, scoped
 * to the equipment-revision (RELPG) attachment table.
 *
 * Auth composition:
 *   - WRITE endpoints (upload / delete) mount
 *     `JwtAuthGuard, WorkStatusApprovedGuard, AgencyOnlyGuard`. The
 *     `AgencyOnlyGuard` enforces §5.3 (equipment writes are agency-only) —
 *     this is STRONGER than the RPG attachment surface (which uses only
 *     `JwtAuthGuard`) and is never looser, per the wave instruction.
 *   - READ / download endpoints mount `JwtAuthGuard` only — read access is
 *     unrestricted to any authenticated user (parity with the RPG
 *     attachment download and §5.3 "reads unrestricted").
 *   - The `public/:id` view endpoint is signed-token gated (no JWT), exactly
 *     as the RPG attachment public view.
 *
 * Deliberate divergence: the RPG `/analysis` + `/analysis/retry` endpoints
 * are OMITTED — equipment AI document-analysis is out of scope (see service).
 */
@Controller({
  path: 'attachment-revised-equipment-project-groups',
  version: '1',
})
export class AttachmentRevisedEquipmentProjectGroupsController {
  private readonly logger = new Logger(
    AttachmentRevisedEquipmentProjectGroupsController.name,
  );

  constructor(
    private readonly attachmentService: AttachmentRevisedEquipmentProjectGroupsService,
  ) {}

  @Get('public/:id')
  async viewFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') signedToken: string,
    @Res() res: Response,
  ) {
    this.logger.log(
      `Viewing revised-equipment file with ID: ${id} with signed token`,
    );

    if (!signedToken || !UrlSigningUtil.validateSignedToken(id, signedToken)) {
      this.logger.warn(
        `Invalid or missing signed token for revised-equipment file ID: ${id}`,
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
      `Generating signed URL for revised-equipment file ID: ${id} by user: ${req.user.userId}`,
    );

    const fileExists = await this.attachmentService.fileExists(id);
    if (!fileExists) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    const baseUrl = `${process.env.APP_URL}/api/v1/attachment-revised-equipment-project-groups/public/${id}`;
    const signedUrl = UrlSigningUtil.generateSignedUrl(baseUrl, id);

    return {
      signedUrl,
      expiresIn: '24 hours',
      fileId: id,
    };
  }

  @UseGuards(JwtAuthGuard, WorkStatusApprovedGuard, AgencyOnlyGuard)
  @Post('upload/:revisedEquipmentProjectGroupId')
  @UseInterceptors(FilesInterceptor('files', 10, multerConfig))
  async uploadFiles(
    @Param('revisedEquipmentProjectGroupId', ParseUUIDPipe)
    revisedEquipmentProjectGroupId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Uploading ${files.length} files for revisedEquipmentProjectGroup: ${revisedEquipmentProjectGroupId} by user: ${req.user.userId}`,
    );

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
      revisedEquipmentProjectGroupId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('revised-equipment-project-group/:revisedEquipmentProjectGroupId')
  async findByRevisedEquipmentProjectGroup(
    @Param('revisedEquipmentProjectGroupId', ParseUUIDPipe)
    revisedEquipmentProjectGroupId: string,
  ) {
    return this.attachmentService.findByRevisedEquipmentProjectGroupId(
      revisedEquipmentProjectGroupId,
    );
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

  @UseGuards(JwtAuthGuard, WorkStatusApprovedGuard, AgencyOnlyGuard)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.attachmentService.remove(id);
    return { message: 'File deleted successfully' };
  }
}
