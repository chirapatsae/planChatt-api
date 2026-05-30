import {
  Controller,
  Post,
  Body,
  Res,
  Get,
  Req,
  UseGuards,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ParseIntPipe,
} from '@nestjs/common';
import { PdfService } from './pdf.service';
import { Response, Request } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

// Wave Print ผ.03 — BE-01 (2026-05-28). User-side equipment print
// endpoint + DTO + generator service. Q4 LOCKED: sibling endpoint
// `POST /v1/pdf/generate-por03`.
import { Por03PdfService } from './por03-pdf.service';
import { GeneratePor03Dto } from './dto/generate-por03.dto';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

// SUPP_PRINT_BE_03 — supplement-PDF endpoints.
import { SupplementPdfService } from './supplement-pdf.service';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { Role } from 'src/auth/roles.enum';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { SupplementScopeService } from 'src/common/supplement-scope/supplement-scope.service';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import {
  GenerateSupplementCustomDto,
  GenerateSupplementDraftDto,
} from './dto/supplement-pdf.dto';

/**
 * SUPP_PRINT_BE_03 — allowlist for `selectedColumns` on supplement
 * PDF endpoints. Matches the renderer's column map in
 * `supplement-pdf.service.ts` (`generateSupplementPdfBuffer.columnMap`).
 * Disallowed entries are rejected with `400 INVALID_SUPPLEMENT_PDF_COLUMNS`.
 *
 * The allowlist is intentionally a frozen tuple — adding a new column
 * requires a coordinated change with the renderer (BE_02 / BE_01b).
 */
const SUPPLEMENT_PDF_ALLOWED_COLUMNS = [
  'index',
  'title',
  'objective',
  'target',
  'budget',
  'kpi',
  'expectedResult',
  'mainAgency',
  'amphoe',
  'coordinates',
] as const;

@Controller({
  path: 'pdf',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class PdfController {
  constructor(
    private readonly pdfService: PdfService,
    // SUPP_PRINT_BE_03 — supplement-PDF service + agency-classification
    // gate dependencies. The classification gate is invoked inline by
    // the user-role read endpoints; staff / admin / super-admin bypass
    // it because RolesGuard already constrained the role set.
    private readonly supplementPdfService: SupplementPdfService,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly supplementScopeService: SupplementScopeService,
    @InjectDataSource() private readonly dataSource: DataSource,
    // Wave Print ผ.03 — BE-01 (2026-05-28).
    private readonly por03PdfService: Por03PdfService,
  ) {}

  // ===================================================================
  // SUPP_PRINT_BE_03 — controller-local helpers
  // ===================================================================

  /**
   * Validates `selectedColumns` against `SUPPLEMENT_PDF_ALLOWED_COLUMNS`.
   * Returns the original array (or undefined) on success; throws
   * `BadRequestException('INVALID_SUPPLEMENT_PDF_COLUMNS')` on any
   * disallowed entry. Centralized so all 3 supplement-PDF POST
   * endpoints share the same allowlist enforcement.
   */
  private assertAllowedSupplementColumns(
    selectedColumns?: string[],
  ): string[] | undefined {
    if (!selectedColumns) return undefined;
    const allowed = new Set<string>(SUPPLEMENT_PDF_ALLOWED_COLUMNS);
    const offending = selectedColumns.filter((c) => !allowed.has(c));
    if (offending.length > 0) {
      throw new BadRequestException(
        `INVALID_SUPPLEMENT_PDF_COLUMNS: ${offending.join(',')}`,
      );
    }
    return selectedColumns;
  }

  /**
   * §1 agency-classification gate for `user`-role callers reading
   * supplement-PDF endpoints. Staff / admin / super-admin are
   * exempt — RolesGuard already constrained the role set per task §7.
   *
   * This is a no-op for non-`user` roles so the call site can run it
   * unconditionally without branching.
   *
   * Throws:
   *   - `UnauthorizedException` — missing `req.user.userId`
   *   - `403 LAO_NOT_ALLOWED_ON_SUPPLEMENT` for LAO callers
   *   - `403 SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION` for edge cases
   */
  private async assertAgencyClassificationForUserRole(
    req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    if (req.user?.role !== Role.USER) return;
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.dataSource.manager,
      userId,
    );
    this.supplementScopeService.assertSupplementOwnerScope(workHistory);
  }

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

  // ============================================
  // Wave Print ผ.03 — BE-01 (2026-05-28)
  //
  // User-side equipment print endpoint.
  //
  // Q1 LOCKED — cover layout font + centering byte-for-byte from ผ.02
  //              (`report-summary.part.ts:18-37` + stamp pattern at
  //              `report-project-detail.part.ts:612`).
  // Q2 LOCKED — STRATEGY_BASED only. Per-row re-assertion in
  //              `Por03PdfService.generate` throws
  //              `400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE`.
  // Q3 LOCKED — landscape A4 (rendered by part files).
  // Q4 LOCKED — sibling endpoint `POST /v1/pdf/generate-por03`,
  //              body `{ equipmentIds: string[] }`,
  //              response `200 application/pdf`.
  // Q5 LOCKED — SKIP audit logging. Mirrors ผ.02 endpoint at
  //              `pdf.controller.ts:148-177` which has zero audit calls.
  //              NO TrackingStatus, NO AI snapshot, NO workflow mutation.
  // Q6 LOCKED — cooldown `(workHistoryId, 'print-por03')`, 10s window,
  //              2xx arms / 5xx no-arm, 429 PRINT_COOLDOWN_ACTIVE.
  //              Implemented inside `Por03PdfService`.
  //
  // Defense-in-depth (§5.3):
  //   - Controller-level: JwtAuthGuard (class) + AgencyOnlyGuard
  //     (LAO callers rejected with `403 EQUIPMENT_AGENCY_ONLY`).
  //     BE-02 may swap `AgencyOnlyGuard` for a dedicated
  //     `PrintPor03Guard` that adds workStatus-approved gating; the
  //     service layer re-asserts both checks regardless, so swapping
  //     guards is safe.
  //   - Service-level: `Por03PdfService.generate` re-asserts
  //     `isAgencyWorkHistory(callerWh)`, per-row owner check, and
  //     per-row STRATEGY_BASED shape check.
  //
  // §17.11 — NO super-admin bypass. The agency-only check ignores role.
  // ============================================
  @Post('generate-por03')
  @UseGuards(AgencyOnlyGuard)
  async generatePor03Pdf(
    @Body() body: GeneratePor03Dto,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    const pdfBuffer = await this.por03PdfService.generate(
      userId,
      body.equipmentIds,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="por03-equipment.pdf"',
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

  // Wave staff-draftbook-download-modal (2026-05-30) — scoped on-demand
  // download of the LATEST draft. Body: { scope, selectedColumns? }.
  // scope ∈ {combined, project, equipment}. Read-only (§17.2): renders
  // fresh, writes no version row / audit. Old versions are NOT served
  // here — the FE streams those via the existing :version/stream route.
  @Post('draft/agency/:developmentPlanId/download')
  async downloadScopedDraftAgency(
    @Param('developmentPlanId') developmentPlanId: string,
    @Body() body: { scope?: 'combined' | 'project' | 'equipment'; selectedColumns?: string[] },
    @Res() res: Response,
  ) {
    const scope = body?.scope ?? 'combined';
    const pdfBuffer = await this.pdfService.generateScopedDraftAgencyDownload(
      developmentPlanId,
      scope,
      body?.selectedColumns,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="draft-agency-${scope}.pdf"`,
    });
    res.end(pdfBuffer);
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

  // ===================================================================
  // SUPP_PRINT_BE_03 — Supplement Draft PDF Endpoints
  // ===================================================================
  //
  // Role matrix:
  //   - Draft GET (meta / stream / versions): user (agency-classified) +
  //     staff + admin + super-admin
  //   - Draft POST generate: staff + admin + super-admin (Q1 admin
  //     authoring surface; user CANNOT generate draft per task §7)
  //   - Approved finalize POST: admin + super-admin ONLY (Q8)
  //   - Approved GET (meta / stream / versions): user (agency-classified)
  //     + staff + admin + super-admin
  //
  // Cross-plan defense: every `(planId, supplementId)` URL routes
  // through `resolveSupplementForPlan` which returns null on mismatch,
  // surfacing as 404 here. The controller never trusts the URL planId
  // alone — the supplement is loaded and its parent plan is
  // re-compared.

  /**
   * Endpoint 1 — POST draft generate.
   * Role: staff + admin + super-admin (per task §7 draft generate).
   * Body: `{ developmentPlanId, developmentPlanSupplementId, selectedColumns? }`.
   * Returns: `SupplementPdfVersionPayload` (version metadata).
   * Errors:
   *   - 400 INVALID_SUPPLEMENT_PDF_COLUMNS — disallowed column id
   *   - 400 'ยังไม่มีโครงการที่พร้อมพิมพ์ในรอบเพิ่มเติมนี้' — zero printable SPGs
   *   - 404 — supplement missing / soft-deleted / cross-plan mismatch
   */
  @Post('supplement-draft/development-plan-supplement/generate')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async generateSupplementDraft(
    @Body() body: GenerateSupplementDraftDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const createdById = req.user?.userId;
    if (!createdById) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    // Cross-plan defense — verify the supplement belongs to the
    // supplied plan via the public `getSupplementBookContext` loader.
    // The service's `generateSupplementDraftFromStatus` does not
    // re-validate planId, so this gate prevents emitting a PDF for a
    // mismatched plan.
    const ctx = await this.supplementPdfService.getSupplementBookContext(
      body.developmentPlanSupplementId,
    );
    if (ctx.parentPlan.id !== body.developmentPlanId) {
      throw new NotFoundException(
        'Supplement does not belong to the supplied development plan',
      );
    }

    const selectedColumns = this.assertAllowedSupplementColumns(
      body.selectedColumns,
    );

    return await this.supplementPdfService.generateSupplementDraftFromStatus({
      developmentPlanSupplementId: body.developmentPlanSupplementId,
      createdById,
      selectedColumns,
    });
  }

  /**
   * Endpoint 2 — POST custom supplement PDF (one-shot, no version row).
   * Mirrors `generate-revision-custom`. Returns binary PDF inline.
   *
   * 2026-05-14 — user-side widening: `Role.USER` accepted so agency
   * users can print their own in-flight supplement projects as paper
   * for the hybrid digital + paper submission workflow (mirror of
   * `/revision/print` for revision/change). The `user` role MUST pass
   * the §1 agency classification gate; staff/admin/super-admin bypass
   * via `assertAgencyClassificationForUserRole`'s role short-circuit.
   *
   * Body: `{ ids, selectedColumns? }` — SPG ids; all MUST belong to the
   * same supplement.
   */
  @Post('generate-supplement-custom')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async generateSupplementCustomPdf(
    @Body() body: GenerateSupplementCustomDto,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    // §1 agency-classification gate for `user` role (no-op for higher roles).
    await this.assertAgencyClassificationForUserRole(req);

    const createdById = req.user?.userId;
    if (!createdById) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const selectedColumns =
      this.assertAllowedSupplementColumns(body.selectedColumns) ?? [
        'index',
        'title',
        'objective',
        'target',
        'budget',
        'expectedResult',
        'mainAgency',
      ];

    const projects = await this.supplementPdfService.findSupplementProjectsByIds(
      body.ids,
    );
    if (projects.length === 0) {
      res.status(404).json({
        message: 'No supplement projects found for the provided IDs',
      });
      return;
    }

    const { buffer } = await this.supplementPdfService.generateSupplementCustomBuffer({
      projects,
      selectedColumns,
      createdById,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename="custom-supplement-report.pdf"',
    });
    res.end(buffer);
  }

  /**
   * Endpoint 3 — GET latest draft meta.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-draft/:developmentPlanId/:developmentPlanSupplementId/latest/meta')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async getLatestSupplementDraftMeta(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const meta = await this.supplementPdfService.getLatestSupplementDraftMeta(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!meta) {
      throw new NotFoundException('Supplement draft PDF not found');
    }
    return meta;
  }

  /**
   * Endpoint 4 — GET latest draft stream.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-draft/:developmentPlanId/:developmentPlanSupplementId/latest/stream')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async streamLatestSupplementDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const latest = await this.supplementPdfService.readLatestSupplementDraftFile(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!latest) {
      res.status(404).json({ message: 'Supplement draft PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="supplement-draft-${developmentPlanSupplementId}.pdf"`,
    );
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  /**
   * Endpoint 5 — GET all draft versions.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-draft/:developmentPlanId/:developmentPlanSupplementId/latest/versions')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async getAllSupplementDraftVersions(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const rows = await this.supplementPdfService.getAllSupplementDraftVersionsForPlan(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!rows) {
      throw new NotFoundException(
        'DevelopmentPlanSupplement not found for the supplied plan',
      );
    }
    return rows;
  }

  /**
   * Endpoint 6 — GET specific draft version stream.
   * Role: user (agency) + staff + admin + super-admin.
   * `:version` is parsed as an integer; non-integer values yield 400.
   */
  @Get('supplement-draft/:developmentPlanId/:developmentPlanSupplementId/:version/stream')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async streamSupplementDraftByVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const draft = await this.supplementPdfService.readSupplementDraftFileByVersion(
      developmentPlanId,
      developmentPlanSupplementId,
      version,
    );
    if (!draft) {
      res.status(404).json({ message: 'Supplement draft PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="supplement-draft-${developmentPlanSupplementId}-v${version}.pdf"`,
    );
    const stream = draft.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  // ===================================================================
  // SUPP_PRINT_BE_03 — Supplement Approved PDF Endpoints
  // ===================================================================
  //
  // SUPP_STANDALONE_CLEANUP_BE_01 (Wave 5, 2026-05-14) — the legacy
  // single-click finalize endpoint
  // `POST /v1/pdf/supplement-approved/development-plan-supplement/generate`
  // was REMOVED in this wave. The §18.2.1 SUPPLEMENT finalize trigger
  // surface now lives EXCLUSIVELY at
  // `POST /v1/supplement-assembly/:supplementId/finalize` (see
  // `SupplementAssemblyController`). The GET read endpoints below are
  // retained for legacy archive access to existing
  // `PdfSupplementApprovedDocument` rows.

  /**
   * Endpoint 8 — GET latest approved meta.
   * Role: user (agency) + staff + admin + super-admin.
   *
   * URL is supplement-scoped (no planId) per task §3 endpoint #8. The
   * approved book is a single artifact per supplement and does not
   * need the planId disambiguation that draft endpoints carry.
   */
  @Get('supplement-approved/:developmentPlanSupplementId/latest/meta')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async getLatestSupplementApprovedMeta(
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const meta = await this.supplementPdfService.getLatestSupplementApprovedMeta(
      developmentPlanSupplementId,
    );
    if (!meta) {
      throw new NotFoundException('Supplement approved PDF not found');
    }
    return meta;
  }

  /**
   * Endpoint 9 — GET latest approved stream.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-approved/:developmentPlanSupplementId/latest/stream')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async streamLatestSupplementApproved(
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const latest = await this.supplementPdfService.readLatestSupplementApprovedFile(
      developmentPlanSupplementId,
    );
    if (!latest) {
      res.status(404).json({ message: 'Supplement approved PDF not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="supplement-approved-${developmentPlanSupplementId}.pdf"`,
    );
    const stream = latest.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

  /**
   * Endpoint 10 — GET all approved versions.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-approved/:developmentPlanSupplementId/latest/versions')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async getAllSupplementApprovedVersions(
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    return this.supplementPdfService.getSupplementApprovedVersions(
      developmentPlanSupplementId,
    );
  }

  /**
   * Endpoint 11 — GET specific approved version stream.
   * Role: user (agency) + staff + admin + super-admin.
   */
  @Get('supplement-approved/:developmentPlanSupplementId/:version/stream')
  @UseGuards(RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.USER, Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN)
  async streamSupplementApprovedByVersion(
    @Param('developmentPlanSupplementId') developmentPlanSupplementId: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    await this.assertAgencyClassificationForUserRole(req);
    const approved = await this.supplementPdfService.readSupplementApprovedFileByVersion(
      developmentPlanSupplementId,
      version,
    );
    if (!approved) {
      res.status(404).json({ message: 'Supplement approved PDF version not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="supplement-approved-${developmentPlanSupplementId}-v${version}.pdf"`,
    );
    const stream = approved.stream;
    stream.pipe(res);
    stream.on('error', () => res.end());
  }

}
