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

  @Post('generate-custom')
  async generateCustomPdf(@Body() body: any, @Res() res: Response) {
    const { projects, selectedColumns } = body;
    const pdfBuffer = await this.pdfService.generateProjectReportWithColumns(
      projects,
      selectedColumns || ['index', 'title', 'objective', 'target', 'budget', 'kpi', 'expectedResult', 'mainAgency']
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=custom-project-report.pdf',
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

  // Approved PDF endpoints (สำหรับโครงการที่อนุมัติแล้ว)
  @Post('approved/generate')
  async generateApproved(@Body() body: any, @Req() req: Request) {
    const projects: any[] = body?.projects || [];
    const projectIdsSnapshot = projects.map((p) => p.id);
    const createdById = (req as any).user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    const pdfBuffer = await this.pdfService.generateProjectReport(projects);
    const saved = await this.pdfService.saveApprovedPdfAndMeta({
      pdfBuffer,
      projectIdsSnapshot,
      createdById,
    });
    return saved;
  }

  @Get('approved/latest/meta')
  async getLatestApprovedMeta() {
    return this.pdfService.getLatestApprovedMeta();
  }

  @Get('approved/versions')
  async getAllApprovedVersions() {
    return this.pdfService.getAllApprovedVersions();
  }

  @Get('approved/latest/stream')
  async streamLatestApproved(@Res() res: Response) {
    const latest = await this.pdfService.readLatestApprovedFile();
    if (!latest) {
      res.status(404).json({ message: 'Approved PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('approved/:version/stream')
  async streamApprovedByVersion(@Param('version') version: number, @Res() res: Response) {
    const approved = await this.pdfService.readApprovedFileByVersion(version);
    if (!approved) {
      res.status(404).json({ message: 'Approved PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = approved.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // In Authority PDF endpoints (สำหรับโครงการที่อยู่ในอำนาจ)
  @Post('in-authority/generate')
  async generateInAuthority(@Body() body: any, @Req() req: Request) {
    const projects: any[] = body?.projects || [];
    const projectIdsSnapshot = projects.map((p) => p.id);
    const createdById = (req as any).user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    const pdfBuffer = await this.pdfService.generateProjectReport(projects);
    const saved = await this.pdfService.saveInAuthorityPdfAndMeta({
      pdfBuffer,
      projectIdsSnapshot,
      createdById,
    });
    return saved;
  }

  @Get('in-authority/latest/meta')
  async getLatestInAuthorityMeta() {
    return this.pdfService.getLatestInAuthorityMeta();
  }

  @Get('in-authority/versions')
  async getAllInAuthorityVersions() {
    return this.pdfService.getAllInAuthorityVersions();
  }

  @Get('in-authority/latest/stream')
  async streamLatestInAuthority(@Res() res: Response) {
    const latest = await this.pdfService.readLatestInAuthorityFile();
    if (!latest) {
      res.status(404).json({ message: 'In Authority PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('in-authority/:version/stream')
  async streamInAuthorityByVersion(@Param('version') version: number, @Res() res: Response) {
    const inAuthority = await this.pdfService.readInAuthorityFileByVersion(version);
    if (!inAuthority) {
      res.status(404).json({ message: 'In Authority PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = inAuthority.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // Out Authority PDF endpoints (สำหรับโครงการนอกอำนาจ)
  @Post('out-authority/generate')
  async generateOutAuthority(@Body() body: any, @Req() req: Request) {
    const projects: any[] = body?.projects || [];
    const projectIdsSnapshot = projects.map((p) => p.id);
    const createdById = (req as any).user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    const pdfBuffer = await this.pdfService.generateProjectReport(projects);
    const saved = await this.pdfService.saveOutAuthorityPdfAndMeta({
      pdfBuffer,
      projectIdsSnapshot,
      createdById,
    });
    return saved;
  }

  @Get('out-authority/latest/meta')
  async getLatestOutAuthorityMeta() {
    return this.pdfService.getLatestOutAuthorityMeta();
  }

  @Get('out-authority/versions')
  async getAllOutAuthorityVersions() {
    return this.pdfService.getAllOutAuthorityVersions();
  }

  @Get('out-authority/latest/stream')
  async streamLatestOutAuthority(@Res() res: Response) {
    const latest = await this.pdfService.readLatestOutAuthorityFile();
    if (!latest) {
      res.status(404).json({ message: 'Out Authority PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('out-authority/:version/stream')
  async streamOutAuthorityByVersion(@Param('version') version: number, @Res() res: Response) {
    const outAuthority = await this.pdfService.readOutAuthorityFileByVersion(version);
    if (!outAuthority) {
      res.status(404).json({ message: 'Out Authority PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = outAuthority.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }
}
