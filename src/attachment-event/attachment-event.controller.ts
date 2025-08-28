import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  Res,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Logger,
  Req,
  Query,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AttachmentEventService } from './attachment-event.service';
import { multerConfig } from './multer.config';
import { CreateAttachmentEventDto } from './dto/create-attachment-event.dto';
import { UpdateAttachmentEventDto } from './dto/update-attachment-event.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Request, Response } from 'express';
import { UrlSigningUtil } from 'src/util/url-signing.util';

@Controller({
  path: 'attachment-events',
  version: '1',
})
export class AttachmentEventController {
  private readonly logger = new Logger(AttachmentEventController.name);

  constructor(private readonly attachmentEventService: AttachmentEventService) {}

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
    
    return this.attachmentEventService.viewFile(id, res);
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
    const fileExists = await this.attachmentEventService.fileExists(id);
    if (!fileExists) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }
    
    // สร้าง signed URL
    const baseUrl = `${req.protocol}://${req.get('host')}/api/v1/attachment-events/public/${id}`;
    const signedUrl = UrlSigningUtil.generateSignedUrl(baseUrl, id);
    
    return {
      signedUrl,
      expiresIn: '24 hours',
      fileId: id
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createAttachmentEventDto: CreateAttachmentEventDto) {
    this.logger.log(`Creating new attachment for event: ${createAttachmentEventDto.eventId}`);
    return this.attachmentEventService.create(createAttachmentEventDto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload/:eventId')
  @UseInterceptors(FilesInterceptor('files', 10, multerConfig))
  async uploadFiles(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtPayloadUser }
  ) {
    this.logger.log(`Uploading ${files.length} files for event: ${eventId} by user: ${req.user.userId}`);
    
    // Fix UTF-8 encoding for filenames
    const fixedFiles = files.map(file => {
      const originalName = file.originalname;
      const fixedName = Buffer.from(originalName, 'latin1').toString('utf8');
      
      this.logger.log(`Original filename: ${originalName}`);
      this.logger.log(`Fixed filename: ${fixedName}`);
      
      return {
        ...file,
        originalname: fixedName
      };
    });
    
    return this.attachmentEventService.uploadMultipleFiles(fixedFiles, eventId);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll() {
    this.logger.log('Fetching all attachments');
    return this.attachmentEventService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Get('event/:eventId')
  async findByEventId(@Param('eventId', ParseUUIDPipe) eventId: string) {
    this.logger.log(`Fetching attachments for event: ${eventId}`);
    return this.attachmentEventService.findByEventId(eventId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching attachment with ID: ${id}`);
    return this.attachmentEventService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAttachmentEventDto: UpdateAttachmentEventDto
  ) {
    this.logger.log(`Updating attachment with ID: ${id}`);
    return this.attachmentEventService.update(id, updateAttachmentEventDto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Deleting attachment with ID: ${id}`);
    return this.attachmentEventService.remove(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async downloadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response
  ) {
    this.logger.log(`Downloading file with ID: ${id}`);
    return this.attachmentEventService.downloadFile(id, res);
  }
}
