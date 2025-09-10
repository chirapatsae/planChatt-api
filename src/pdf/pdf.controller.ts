import { Controller, Post, Body, Res, Get, Req, UseGuards, Param } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { Response, Request } from 'express';
import * as fs from 'fs';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'pdf',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('generate')
  async generatePdf(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.pdfService.generateProjectReport(
      body.projects,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=project-report.pdf',
    });

    res.end(pdfBuffer);
  }

  // Draft development plan endpoints (database-backed)
  @Post('draft/generate')
  async generateDraft(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const projects: any[] = body?.projects || [];
    const projectIdsSnapshot = projects.map((p) => p.id);
    const createdById = req.user?.userId; // Assuming user info is in request from auth guard
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    const pdfBuffer = await this.pdfService.generateProjectReport(projects);
    const saved = await this.pdfService.saveDraftPdfAndMeta({
      pdfBuffer,
      projectIdsSnapshot,
      createdById,
    });
    return saved;
  }

  @Get('draft/latest/meta')
  async getLatestDraftMeta() {
    return this.pdfService.getLatestDraftMeta();
  }

  @Get('draft/latest/stream')
  async streamLatestDraft(@Res() res: Response) {
    const latest = await this.pdfService.readLatestDraftFile();
    if (!latest) {
      res.status(404).json({ message: 'Draft PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('draft/versions')
  async getAllDraftVersions() {
    return this.pdfService.getAllDraftVersions();
  }

  @Get('draft/:version/stream')
  async streamDraftByVersion(@Param('version') version: number, @Res() res: Response) {
    const draft = await this.pdfService.readDraftFileByVersion(version);
    if (!draft) {
      res.status(404).json({ message: 'Draft PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = draft.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }
}
