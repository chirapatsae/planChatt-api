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
import { AttachmentRevisedProjectGroupsService } from './attachment-revised-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';
import { DocumentAnalysisService } from 'src/document-analysis/document-analysis.service';

const STAFF_LEAD_ROLES = new Set(['staff', 'admin', 'super-admin']);

@Controller({
  path: 'attachment-revised-project-groups',
  version: '1',
})
export class AttachmentRevisedProjectGroupsController {
  private readonly logger = new Logger(AttachmentRevisedProjectGroupsController.name);

  constructor(
    private readonly attachmentService: AttachmentRevisedProjectGroupsService,
    private readonly documentAnalysisService: DocumentAnalysisService,
  ) { }

  @Get('public/:id')
  async viewFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') signedToken: string,
    @Res() res: Response
  ) {
    this.logger.log(`Viewing revised file with ID: ${id} with signed token`);

    if (!signedToken || !UrlSigningUtil.validateSignedToken(id, signedToken)) {
      this.logger.warn(`Invalid or missing signed token for revised file ID: ${id}`);
      throw new UnauthorizedException('Token ไม่ถูกต้องหรือหมดอายุ');
    }

    return this.attachmentService.viewFile(id, res);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/signed-url')
  async generateSignedUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser }
  ) {
    this.logger.log(`Generating signed URL for revised file ID: ${id} by user: ${req.user.userId}`);

    const fileExists = await this.attachmentService.fileExists(id);
    if (!fileExists) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    const baseUrl = `${process.env.APP_URL}/api/v1/attachment-revised-project-groups/public/${id}`;
    const signedUrl = UrlSigningUtil.generateSignedUrl(baseUrl, id);

    return {
      signedUrl,
      expiresIn: '24 hours',
      fileId: id
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload/:revisedProjectGroupId')
  @UseInterceptors(FilesInterceptor('files', 10, multerConfig))
  async uploadFiles(
    @Param('revisedProjectGroupId', ParseUUIDPipe) revisedProjectGroupId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Uploading ${files.length} files for revisedProjectGroup: ${revisedProjectGroupId} by user: ${req.user.userId}`);

    const fixedFiles = files.map(file => {
      const originalName = file.originalname;
      const fixedName = Buffer.from(originalName, 'latin1').toString('utf8');

      return {
        ...file,
        originalname: fixedName
      };
    });

    return this.attachmentService.uploadMultipleFiles(
      fixedFiles,
      revisedProjectGroupId,
      req.user.userId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('revised-project-group/:revisedProjectGroupId')
  async findByRevisedProjectGroup(
    @Param('revisedProjectGroupId', ParseUUIDPipe) revisedProjectGroupId: string,
  ) {
    return this.attachmentService.findByRevisedProjectGroupId(revisedProjectGroupId);
  }

  // AI analysis — read current status + summary
  @UseGuards(JwtAuthGuard)
  @Get(':id/analysis')
  async getAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.documentAnalysisService.getAnalysis(
      'revised-project-group',
      id,
    );
    if (!result) {
      throw new NotFoundException(`Attachment with ID ${id} not found`);
    }
    return result;
  }

  // AI analysis — staff-lead retry for failed rows
  @UseGuards(JwtAuthGuard)
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
      'revised-project-group',
      id,
      req.user.userId,
    );
    return { status: 'processing', attachmentId: id };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
  ) {
    await this.attachmentService.remove(id);
    return { message: 'File deleted successfully' };
  }
}
