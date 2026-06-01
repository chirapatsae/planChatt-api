import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class RecordViewDto {
  // `'supplement_project_group'` widened in Wave public-archive-
  // supplement BE-01. SPG-level view tracking only; supplement
  // BOOK-level view counter is deferred per BE-01 §6.6 (the plan-level
  // rollup is sufficient and supplement adds no separate book-level
  // view column).
  @IsIn([
    'project_group',
    'revised_project_group',
    'supplement_project_group',
    'development_plan',
  ])
  targetKind:
    | 'project_group'
    | 'revised_project_group'
    | 'supplement_project_group'
    | 'development_plan';

  @IsUUID()
  targetId: string;

  @IsUUID()
  deviceId: string;

  /**
   * Wave per-version-engagement-counts (2026-06-01) — OPTIONAL book
   * version attribution. When present, the view is recorded against a
   * single assembled book version so the public archive can show
   * per-`<VersionRow>` view counts. Sent alongside (not instead of)
   * `targetKind:'development_plan'` + `targetId:planId`, so the
   * plan-level counter still increments. Legacy callers omit these.
   *
   * §17.3 — `sourceId` is a plain UUID; no FK is implied.
   */
  @IsOptional()
  @IsIn(['main_plan', 'edit_revision', 'change_revision', 'supplement'])
  sourceType?: 'main_plan' | 'edit_revision' | 'change_revision' | 'supplement';

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;
}
