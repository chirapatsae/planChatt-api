import { Controller, Post, Body, Res, Get, Req, UseGuards, Param, Query } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { Response, Request } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'pdf',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  // ============================================
  // Basic PDF Generation Endpoints
  // ============================================
  @Post('generate')
  async generatePdf(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.pdfService.generateProjectDetailsOnly(
      body.projects,
      body.selectedColumns,
      { developmentPlanId: body.developmentPlanId, reportType: body.type },
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=project-report.pdf',
    });

    res.end(pdfBuffer);
  }

  @Post('generate-custom')
  async generateCustomPdf(@Body() body: any, @Res() res: Response) {
    const { projectSnapShot, selectedColumns, developmentPlanId, type } = body;
    
    if (!projectSnapShot || !Array.isArray(projectSnapShot) || projectSnapShot.length === 0) {
      res.status(400).json({ message: 'projectSnapShot is required and must be a non-empty array' });
      return;
    }

    // Query projects from IDs
    const projects = await this.pdfService.findProjectsByIds(projectSnapShot);
    
    if (projects.length === 0) {
      res.status(404).json({ message: 'No projects found for the provided IDs' });
      return;
    }

    const pdfBuffer = await this.pdfService.generateProjectReportWithColumns(
      projects,
      selectedColumns || ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      { developmentPlanId, reportType: type }
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=custom-project-report.pdf',
    });

    res.end(pdfBuffer);
  }

  @Post('generate-custom-out-authority')
  async generateCustomPdfOutAuthority(@Body() body: any, @Res() res: Response) {
    const { selectedColumns, developmentPlanId } = body;
    
    // Query projects from development plan IDs for out-authority
    const projects = await this.pdfService.findProjectsForOutAuthority(developmentPlanId);
    
    if (projects.length === 0) {
      res.status(404).json({ message: 'No projects found for the provided IDs' });
      return;
    }

    const pdfBuffer = await this.pdfService.generateProjectReportWithColumns(
      projects,
      selectedColumns || ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      { developmentPlanId, reportType: 'outAuthority' }
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=custom-project-report.pdf',
    });

    res.end(pdfBuffer);
  }

  // ============================================
  // Draft PDF Endpoints (สำหรับร่างแผนพัฒนาของส่วนราชการ)
  // ============================================

  @Post('draft/agency/development-plan/generate')
  async generateDraft(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const { developmentPlanId } = body;
    const createdById = req.user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    if (!developmentPlanId) {
      throw new Error('developmentPlanId is required');
    }

    // Query โครงการที่มี status: Verified, Pending_Approval, Approved
    const result = await this.pdfService.generateDraftAgencyFromStatus({
      developmentPlanId,
      createdById,
    });

    return result;
  }

  @Get('draft/agency/:developmentPlanId/latest/meta')
  async getLatestDraftAgencyMetaForPlan(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getLatestDraftAgencyMetaForPlan(developmentPlanId);
  }

  @Get('draft/agency/:developmentPlanId/latest/stream')
  async streamLatestDraftAgencyForPlan(@Param('developmentPlanId') developmentPlanId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestDraftAgencyFileForPlan(developmentPlanId);
    if (!latest) {
      res.status(404).json({ message: 'Draft PDF not found for this development plan' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('draft/agency/:developmentPlanId/latest/versions')
  async getAllDraftAgencyVersions(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getAllDraftAgencyVersions(developmentPlanId);
  }

  @Get('draft/agency/:developmentPlanId/:version/stream')
  async streamDraftAgencyByVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('version') version: number,
    @Res() res: Response
  ) {
    const draft = await this.pdfService.readDraftAgencyFileByVersion(developmentPlanId, version);
    if (!draft) {
      res.status(404).json({ message: 'Draft PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = draft.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // ============================================
  // Draft Coordinate PDF Endpoints (สำหรับร่างแผนประสานแผน)
  // ============================================

  @Post('draft/coordinate/development-plan/generate')
  async generateDraftCoordinate(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const { developmentPlanId } = body;
    const createdById = req.user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    if (!developmentPlanId) {
      throw new Error('developmentPlanId is required');
    }

    // Query โครงการที่มี status: Verified สำหรับ draft coordinate
    const result = await this.pdfService.generateInAuthorityFromStatus({
      developmentPlanId,
      createdById,
    });

    return result;
  }

  @Get('draft/coordinate/:developmentPlanId/latest/meta')
  async getLatestDraftCoordinateMetaForPlan(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getLatestInAuthorityMetaForPlan(developmentPlanId);
  }

  @Get('draft/coordinate/:developmentPlanId/latest/stream')
  async streamLatestDraftCoordinateForPlan(@Param('developmentPlanId') developmentPlanId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestInAuthorityFileForPlan(developmentPlanId);
    if (!latest) {
      res.status(404).json({ message: 'Draft Coordinate PDF not found for this development plan' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('draft/coordinate/:developmentPlanId/latest/versions')
  async getAllDraftCoordinateVersions(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getAllInAuthorityVersionsForPlan(developmentPlanId);
  }

  @Get('draft/coordinate/:developmentPlanId/:version/stream')
  async streamDraftCoordinateByVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('version') version: number,
    @Res() res: Response
  ) {
    const draftCoordinate = await this.pdfService.readInAuthorityFileByVersionForPlan(developmentPlanId, version);
    if (!draftCoordinate) {
      res.status(404).json({ message: 'Draft Coordinate PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = draftCoordinate.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

    // ============================================
  // Out Authority PDF Endpoints (สำหรับโครงการนอกอำนาจ)
  // ============================================

  @Post('out-authority/development-plan/generate')
  async generateOutAuthority(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const { developmentPlanId } = body;
    const createdById = req.user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    if (!developmentPlanId) {
      throw new Error('developmentPlanId is required');
    }

    // Query โครงการที่มี status: Rejected สำหรับ out-authority
    const result = await this.pdfService.generateOutAuthorityFromStatus({
      developmentPlanId,
      createdById,
    });

    return result;
  }

  @Get('out-authority/:developmentPlanId/latest/meta')
  async getLatestOutAuthorityMetaForPlan(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getLatestOutAuthorityMetaForPlan(developmentPlanId);
  }

  @Get('out-authority/:developmentPlanId/latest/stream')
  async streamLatestOutAuthorityForPlan(@Param('developmentPlanId') developmentPlanId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestOutAuthorityFileForPlan(developmentPlanId);
    if (!latest) {
      res.status(404).json({ message: 'Out Authority PDF not found for this development plan' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('out-authority/:developmentPlanId/latest/versions')
  async getAllOutAuthorityVersions(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getAllOutAuthorityVersionsForPlan(developmentPlanId);
  }

  @Get('out-authority/:developmentPlanId/:version/stream')
  async streamOutAuthorityByVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('version') version: number,
    @Res() res: Response
  ) {
    const outAuthority = await this.pdfService.readOutAuthorityFileByVersionForPlan(developmentPlanId, version);
    if (!outAuthority) {
      res.status(404).json({ message: 'Out Authority PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = outAuthority.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // ============================================
  // Revision Edit Draft PDF Endpoints (สำหรับเล่มร่างแก้ไข)
  // ============================================

  @Post('revision-edit-draft/development-plan-revision/generate')
  async generateRevisionEditDraft(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const { developmentPlanId, developmentPlanRevisionId } = body;
    const createdById = req.user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    if (!developmentPlanId) {
      throw new Error('developmentPlanId is required');
    }

    if (!developmentPlanRevisionId) {
      throw new Error('developmentPlanRevisionId is required');
    }

    // Query โครงการที่มี status: Pending_Approval, Approved และ revisionType = 'แก้ไข'
    const result = await this.pdfService.generateRevisionEditDraftFromStatus({
      developmentPlanId,
      developmentPlanRevisionId,
      createdById,
    });

    return result;
  }

  @Post('generate-revision-custom')
  async generateRevisionCustomPdf(@Body() body: any, @Res() res: Response) {
    const { ids, selectedColumns } = body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ message: 'ids is required and must be a non-empty array' });
      return;
    }

    // Query revised projects from IDs
    const revisedProjects = await this.pdfService.findRevisedProjectsByIds(ids);
    
    if (revisedProjects.length === 0) {
      res.status(404).json({ message: 'No revised projects found for the provided IDs' });
      return;
    }

    // Get developmentPlanRevisionId and type from first project
    const firstProject = revisedProjects[0];
    const developmentPlanRevisionId = firstProject?.developmentPlanRevision?.id;
    const revisionType = firstProject?.developmentPlanRevision?.revisionType?.name;

    if (!developmentPlanRevisionId || !revisionType) {
      res.status(400).json({ message: 'Invalid revised projects: missing revision metadata' });
      return;
    }

    const columnsToUse = selectedColumns || ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'];
    let pdfBuffer: Buffer;

    if (revisionType === 'แก้ไข') {
      pdfBuffer = await this.pdfService.generateRevisionEditDraftReportWithColumns(
        developmentPlanRevisionId,
        columnsToUse,
        revisedProjects,
      );
    } else if (revisionType === 'เปลี่ยนแปลง') {
      pdfBuffer = await this.pdfService.generateRevisionChangeDraftReportWithColumns(
        developmentPlanRevisionId,
        columnsToUse,
        revisedProjects,
      );
    } else {
      res.status(400).json({ message: `Unsupported revision type: ${revisionType}` });
      return;
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=custom-revision-report.pdf',
    });

    res.end(pdfBuffer);
  }

  @Post('generate-revision-details-only')
  async generateRevisionDetailsOnly(@Body() body: any, @Res() res: Response) {
    const { ids, selectedColumns } = body;
    
    if (!ids) {
      res.status(400).json({ message: 'ids is required' });
      return;
    }
    
    if (!Array.isArray(ids)) {
      res.status(400).json({ message: 'ids must be an array' });
      return;
    }
    
    if (ids.length === 0) {
      res.status(400).json({ message: 'ids must not be empty' });
      return;
    }

    // Query revised projects from IDs
    const revisedProjects = await this.pdfService.findRevisedProjectsByIds(ids);
    
    if (revisedProjects.length === 0) {
      res.status(404).json({ message: 'No revised projects found for the provided IDs' });
      return;
    }

    // Get developmentPlanRevisionId from first project
    const developmentPlanRevisionId = revisedProjects[0]?.developmentPlanRevision?.id;
    if (!developmentPlanRevisionId) {
      res.status(400).json({ message: 'Invalid revised projects: missing developmentPlanRevisionId' });
      return;
    }

    const pdfBuffer = await this.pdfService.generateRevisionEditDetailsOnly(
      developmentPlanRevisionId,
      selectedColumns || ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      revisedProjects,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=revision-details-only.pdf',
    });

    res.end(pdfBuffer);
  }

  @Get('revision-edit-draft/:developmentPlanId/:developmentPlanRevisionId/latest/meta')
  async getLatestRevisionEditDraftMeta(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string
  ) {
    return this.pdfService.getLatestRevisionEditDraftMeta(developmentPlanId, developmentPlanRevisionId);
  }

  @Get('revision-edit-draft/:developmentPlanId/:developmentPlanRevisionId/latest/stream')
  async streamLatestRevisionEditDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Res() res: Response
  ) {
    const latest = await this.pdfService.readLatestRevisionEditDraftFile(developmentPlanId, developmentPlanRevisionId);
    if (!latest) {
      res.status(404).json({ message: 'Revision Edit Draft PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('revision-edit-draft/:developmentPlanId/:developmentPlanRevisionId/latest/versions')
  async getAllRevisionEditDraftVersions(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string
  ) {
    return this.pdfService.getAllRevisionEditDraftVersions(developmentPlanId, developmentPlanRevisionId);
  }

  @Get('revision-edit-draft/:developmentPlanId/:developmentPlanRevisionId/:version/stream')
  async streamRevisionEditDraftByVersion(
    @Param('version') version: number,
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Res() res: Response
  ) {
    const draft = await this.pdfService.readRevisionEditDraftFileByVersion(version, developmentPlanId, developmentPlanRevisionId);
    if (!draft) {
      res.status(404).json({ message: 'Revision Edit Draft PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = draft.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // ============================================
  // Revision Change Draft PDF Endpoints (สำหรับเล่มร่างเปลี่ยนแปลง)
  // ============================================

  @Post('revision-change-draft/development-plan-revision/generate')
  async generateRevisionChangeDraft(@Body() body: any, @Req() req: Request & { user: JwtPayloadUser }) {
    const { developmentPlanId, developmentPlanRevisionId } = body;
    const createdById = req.user?.userId;
    
    if (!createdById) {
      throw new Error('User ID not found in request');
    }

    if (!developmentPlanId) {
      throw new Error('developmentPlanId is required');
    }

    if (!developmentPlanRevisionId) {
      throw new Error('developmentPlanRevisionId is required');
    }

    // Query โครงการที่มี status: Pending_Approval, Approved และ revisionType = 'เปลี่ยนแปลง'
    const result = await this.pdfService.generateRevisionChangeDraftFromStatus({
      developmentPlanId,
      developmentPlanRevisionId,
      createdById,
    });

    return result;
  }

  @Get('revision-change-draft/:developmentPlanId/:developmentPlanRevisionId/latest/meta')
  async getLatestRevisionChangeDraftMeta(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string
  ) {
    return this.pdfService.getLatestRevisionChangeDraftMeta(developmentPlanId, developmentPlanRevisionId);
  }

  @Get('revision-change-draft/:developmentPlanId/:developmentPlanRevisionId/latest/stream')
  async streamLatestRevisionChangeDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Res() res: Response
  ) {
    const latest = await this.pdfService.readLatestRevisionChangeDraftFile(developmentPlanId, developmentPlanRevisionId);
    if (!latest) {
      res.status(404).json({ message: 'Revision Change Draft PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('revision-change-draft/:developmentPlanId/:developmentPlanRevisionId/latest/versions')
  async getAllRevisionChangeDraftVersions(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string
  ) {
    return this.pdfService.getAllRevisionChangeDraftVersions(developmentPlanId, developmentPlanRevisionId);
  }

  @Get('revision-change-draft/:developmentPlanId/:developmentPlanRevisionId/:version/stream')
  async streamRevisionChangeDraftByVersion(
    @Param('version') version: number,
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Res() res: Response
  ) {
    const draft = await this.pdfService.readRevisionChangeDraftFileByVersion(version, developmentPlanId, developmentPlanRevisionId);
    if (!draft) {
      res.status(404).json({ message: 'Revision Change Draft PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = draft.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // ============================================
  // Approved PDF Endpoints (สำหรับโครงการที่อนุมัติแล้ว)
  // ============================================


  @Get('approved/:developmentPlanId/latest/meta')
  async getLatestApprovedMetaForPlan(@Param('developmentPlanId') developmentPlanId: string) {
    return this.pdfService.getLatestApprovedMetaForPlan(developmentPlanId);
  }

  @Get('approved/:developmentPlanId/latest/stream')
  async streamLatestApprovedForPlan(@Param('developmentPlanId') developmentPlanId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestApprovedFileForPlan(developmentPlanId);
    if (!latest) {
      res.status(404).json({ message: 'Approved PDF not found for this development plan' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  @Get('approved/versions')
  async getAllApprovedVersions() {
    return this.pdfService.getAllApprovedVersions();
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

  // ============================================
  // Revision Edit Approved PDF Endpoints (สำหรับเล่มอนุมัติแก้ไข)
  // ============================================

  @Get('revision-edit-approved/:revisionId/latest/meta')
  async getLatestApprovedMetaForEditRevision(@Param('revisionId') revisionId: string) {
    return this.pdfService.getLatestApprovedMetaForEditRevision(revisionId);
  }

  @Get('revision-edit-approved/:revisionId/latest/stream')
  async streamLatestApprovedForEditRevision(@Param('revisionId') revisionId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestApprovedFileForEditRevision(revisionId);
    if (!latest) {
      res.status(404).json({ message: 'Approved PDF not found for this development plan revision' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

    // ============================================
  // Revision Change Approved PDF Endpoints (สำหรับเล่มอนุมัติเปลี่ยนแปลง)
  // ============================================

  @Get('revision-change-approved/:revisionId/latest/meta')
  async getLatestApprovedMetaForChangeRevision(@Param('revisionId') revisionId: string) {
    return this.pdfService.getLatestApprovedMetaForChangeRevision(revisionId);
  }

  @Get('revision-change-approved/:revisionId/latest/stream')
  async streamLatestApprovedForChangeRevision(@Param('revisionId') revisionId: string, @Res() res: Response) {
    const latest = await this.pdfService.readLatestApprovedFileForChangeRevision(revisionId);
    if (!latest) {
      res.status(404).json({ message: 'Approved PDF not found for this development plan revision' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }


}
