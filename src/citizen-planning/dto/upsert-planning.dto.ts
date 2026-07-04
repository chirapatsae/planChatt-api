import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type { CitizenPlanningTriageStatus } from '../entities/citizen-planning-entry.entity';

/**
 * Partial upsert of a single executive's planning state for one idea. Every
 * field is optional — the caller sends only what changed (toggle a flag, move
 * triage, edit a note). An empty-string `note` clears the note.
 *
 * §17.2 advisory — none of these fields affect any workflow transition.
 */
export class UpsertPlanningDto {
  @IsOptional()
  @IsIn(['unreviewed', 'reviewing', 'agenda', 'parked'])
  triageStatus?: CitizenPlanningTriageStatus;

  @IsOptional()
  @IsBoolean()
  isFlagged?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * Effort/feasibility band (1 = ง่าย, 2 = กลาง, 3 = ยาก) for the Value×Effort
   * matrix. Send `null` to clear the score (back to "ยังไม่ให้คะแนน"); omit to
   * leave unchanged. @IsOptional skips validation for null/undefined, so only a
   * concrete value is range-checked. §17.2 advisory.
   */
  @IsOptional()
  @IsIn([1, 2, 3])
  effortScore?: number | null;
}
