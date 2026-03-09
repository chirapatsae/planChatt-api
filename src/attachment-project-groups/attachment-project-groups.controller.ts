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
import { AttachmentProjectGroupsService } from './attachment-project-groups.service';
import { multerConfig } from 'src/attachment-event/multer.config';
import { UrlSigningUtil } from 'src/util/url-signing.util';

@Controller({
  path: 'attachment-project-groups',
  version: '1',
})
export class AttachmentProjectGroupsController {
  private readonly logger = new Logger(AttachmentProjectGroupsController.name);

  constructor(
    private readonly attachmentService: AttachmentProjectGroupsService,
  ) { }

  // Public file viewing endpoint with URL signing
  @Get('public/:id')
  async viewFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') signedToken: string,
    @Res() res: Response
  ) {
    this.logger.log(`Viewing file with ID: ${id} with signed token`);

    // ตรวจสอบ signed token
    if (!signedToken || !UrlSigningUtil.validateSignedToken(id, signedToken)) {
      this.logger.warn(`Invalid or missing signed token for file ID: ${id}`);
      throw new UnauthorizedException('Token ไม่ถูกต้องหรือหมดอายุ');
    }

    return this.attachmentService.viewFile(id, res);
  }

  // Generate signed URL for file viewing
  @UseGuards(JwtAuthGuard)
  @Get(':id/signed-url')
  async generateSignedUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser }
  ) {
    this.logger.log(`Generating signed URL for file ID: ${id} by user: ${req.user.userId}`);

    // ตรวจสอบว่าไฟล์มีอยู่จริง
    const fileExists = await this.attachmentService.fileExists(id);
    if (!fileExists) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    // สร้าง signed URL
    const baseUrl = `${process.env.APP_URL}/api/v1/attachment-project-groups/public/${id}`;
    const signedUrl = UrlSigningUtil.generateSignedUrl(baseUrl, id);

    return {
      signedUrl,
      expiresIn: '24 hours',
      fileId: id
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload/:projectGroupId')
  @UseInterceptors(FilesInterceptor('files', 10, multerConfig))
  async uploadFiles(
    @Param('projectGroupId', ParseUUIDPipe) projectGroupId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Uploading ${files.length} files for projectGroup: ${projectGroupId} by user: ${req.user.userId}`);

    // Fix UTF-8 encoding for filenames
    const fixedFiles = files.map(file => {
      const originalName = file.originalname;
      const fixedName = Buffer.from(originalName, 'latin1').toString('utf8');

      return {
        ...file,
        originalname: fixedName
      };
    });

    return this.attachmentService.uploadMultipleFiles(fixedFiles, projectGroupId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('project-group/:projectGroupId')
  async findByProjectGroup(
    @Param('projectGroupId', ParseUUIDPipe) projectGroupId: string,
  ) {
    return this.attachmentService.findByProjectGroupId(projectGroupId);
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


