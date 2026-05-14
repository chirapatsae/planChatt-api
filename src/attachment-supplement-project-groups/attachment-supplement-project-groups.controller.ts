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
import { AttachmentSupplementProjectGroupsService } from './attachment-supplement-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';

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
 * NOTE: AI analysis read + retry endpoints are intentionally OMITTED in
 * this wave because `DocumentAnalysisService` does not yet accept a
 * `'supplement-project-group'` kind. See
 * `TODO(SUPP-3-later)` in the service. Adding the routes is a follow-up
 * once the kind union widens.
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
