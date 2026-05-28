import { IsString, Matches } from 'class-validator';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Query DTO for `GET /v1/equipment-category/scoped`. Both ids are
 * REQUIRED string natural keys (e.g. `TACT004`, `PLAN003`) — NOT UUIDs.
 *
 * SPEC DEVIATION (intentional): the BE-01 spec §5 said `@IsUUID()` for
 * `tacticId` / `planId`. The actual `tactics` / `plans` schemas use
 * string PKs ("the id IS the code" — DB-01 task message correction
 * referenced in `EquipmentCategoryScope` entity header). UUID validation
 * here would reject every legitimate input. Surfaced loudly in the
 * BE-01 report.
 */
export class FindScopedCategoriesQueryDto {
  @IsString()
  @Matches(/^TACT\d+$/, { message: 'tacticId must look like "TACT004"' })
  tacticId: string;

  @IsString()
  @Matches(/^PLAN\d+$/, { message: 'planId must look like "PLAN003"' })
  planId: string;
}
