import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { Role } from 'src/auth/roles.enum';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';

import { EquipmentCategoryService } from './equipment-category.service';
import { CreateEquipmentCategoryDto } from './dto/create-equipment-category.dto';
import { UpdateEquipmentCategoryDto } from './dto/update-equipment-category.dto';
import { FindScopedCategoriesQueryDto } from './dto/find-scoped-categories.query.dto';
import { ReplaceScopesByTacticDto } from './dto/replace-scopes-by-tactic.dto';
import { ReplaceScopesByCategoryDto } from './dto/replace-scopes-by-category.dto';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Routes:
 *   GET    /v1/equipment-category               JWT-only — list all (sortOrder ASC)
 *   GET    /v1/equipment-category/scoped        JWT-only — (tacticId, planId) → list
 *   POST   /v1/equipment-category               admin + super-admin + workStatus=approved
 *   PATCH  /v1/equipment-category/:id           admin + super-admin + workStatus=approved
 *   DELETE /v1/equipment-category/:id           admin + super-admin + workStatus=approved
 *   POST   /v1/equipment-category/:id/restore   admin + super-admin + workStatus=approved
 *   PUT    /v1/equipment-category/scopes/by-tactic    admin + super-admin + workStatus=approved
 *   PUT    /v1/equipment-category/scopes/by-category  admin + super-admin + workStatus=approved
 *
 * 8 endpoints total — the optional `findTacticsWithEquipment` lookup
 * was dropped per BE-01 task message (FE-02 filters client-side).
 *
 * Auth composition:
 *   - Reads: JwtAuthGuard only (mirrors TacticController / PlanController)
 *   - Writes: JwtAuthGuard + RolesGuard + WorkStatusApprovedGuard
 *     (mirrors backup-login.controller.ts admin-write pattern). The
 *     role gate is `admin + super-admin` only — staff role is excluded
 *     because Equipment master-data CRUD is admin-tier curation, NOT
 *     staff-lead workflow authority (per BE-01 task message).
 */
@Controller({ path: 'equipment-category', version: '1' })
export class EquipmentCategoryController {
  constructor(private readonly service: EquipmentCategoryService) {}

  // -------------------------------------------------------------
  //  Public reads (JWT-only)
  // -------------------------------------------------------------

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll() {
    return this.service.findAllCategories();
  }

  @Get('scoped')
  @UseGuards(JwtAuthGuard)
  async findScoped(@Query() query: FindScopedCategoriesQueryDto) {
    return this.service.findScopedCategories(query.tacticId, query.planId);
  }

  /**
   * Wave Equipment ผ.03 Phase 2 (FE-05 follow-up) — 2026-05-28.
   *
   * Returns the raw `(category, plan)` junction rows for a given
   * `tacticId`. Powers the simplified Step-1 wizard UX where the admin
   * picks Strategy → Tactic → Category (no explicit Plan dropdown) —
   * the FE then derives `planId` from this junction:
   *   - If a chosen category maps to a single plan under the tactic →
   *     auto-set planId silently.
   *   - If it maps to multiple plans (only 1 such combo exists in the
   *     current seed: ครุภัณฑ์ยานพาหนะฯ × tactic 5.2 → PLAN001 +
   *     PLAN009) → FE reveals a small inline plan picker.
   *
   * JWT-only (matches the rest of the lookup surface — wizard
   * consumers don't need admin gate).
   */
  @Get('scopes-by-tactic')
  @UseGuards(JwtAuthGuard)
  async findScopesByTactic(@Query('tacticId') tacticId: string) {
    return this.service.findScopesByTactic(tacticId);
  }

  /**
   * Return the FULL `(category, tactic, plan)` junction.
   *
   * Consumed by the AddEquipment Step-1 wizard (2026-05-28 v3 redesign)
   * which pivots Category → Tactic → Plan. Single fetch on page mount;
   * the FE derives each dropdown's options client-side from this rows.
   *
   * JWT-only — same gate as `scopes-by-tactic` (any authenticated
   * caller may read; admin gate is on the writes only).
   */
  @Get('scopes-all')
  @UseGuards(JwtAuthGuard)
  async findAllScopes() {
    return this.service.findAllScopes();
  }

  // -------------------------------------------------------------
  //  Admin writes (admin + super-admin + workStatus=approved)
  // -------------------------------------------------------------

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async create(@Body() dto: CreateEquipmentCategoryDto) {
    return this.service.createCategory(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEquipmentCategoryDto,
  ) {
    return this.service.updateCategory(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async softDelete(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.softDeleteCategory(id);
  }

  @Post(':id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async restore(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.restoreCategory(id);
  }

  @Put('scopes/by-tactic')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async replaceScopesByTactic(@Body() dto: ReplaceScopesByTacticDto) {
    const scopes = await this.service.replaceScopesByTactic(dto);
    return { scopes };
  }

  @Put('scopes/by-category')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async replaceScopesByCategory(@Body() dto: ReplaceScopesByCategoryDto) {
    const scopes = await this.service.replaceScopesByCategory(dto);
    return { scopes };
  }
}
