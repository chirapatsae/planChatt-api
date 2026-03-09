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
import { AttachmentRevisedProjectGroupsService } from './attachment-revised-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';

@Controller({
  path: 'attachment-revised-project-groups',
  version: '1',
})
export class AttachmentRevisedProjectGroupsController {
  private readonly logger = new Logger(AttachmentRevisedProjectGroupsController.name);

  constructor(
    private readonly attachmentService: AttachmentRevisedProjectGroupsService,
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

    const baseUrl = `${req.protocol}://${req.get('host')}/api/v1/attachment-revised-project-groups/public/${id}`;
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

    return this.attachmentService.uploadMultipleFiles(fixedFiles, revisedProjectGroupId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('revised-project-group/:revisedProjectGroupId')
  async findByRevisedProjectGroup(
    @Param('revisedProjectGroupId', ParseUUIDPipe) revisedProjectGroupId: string,
  ) {
    return this.attachmentService.findByRevisedProjectGroupId(revisedProjectGroupId);
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


