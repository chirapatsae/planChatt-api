import { IsBoolean, IsEnum, IsNotEmpty, IsString, Matches } from 'class-validator';
import { CorrectionMode } from '../enums/book-assembly.enums';

export class CorrectBookDto {
  /**
   * Which correction mode to apply:
   * - correction_part1: replace Part 1 only (no project reset)
   * - correction_part2: replace Part 2 only (no project reset)
   * - correction_part3: regenerate Part 3 (full project reset + plan reopen)
   *
   * Note: `cancellation` is handled separately via the /cancel endpoint.
   */
  @IsEnum(CorrectionMode, {
    message: 'correctionMode must be one of: correction_part1, correction_part2, correction_part3',
  })
  correctionMode: CorrectionMode;

  /**
   * Explicit confirmation flag (Spec Section 11.3 step 2).
   */
  @IsBoolean()
  confirmed: boolean;

  /**
   * Last 6 digits of the operator's national ID card number (Spec Section 11.3 step 3).
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'citizenIdSuffix must be exactly 6 digits' })
  citizenIdSuffix: string;

  /**
   * Human-readable reason for correction (Spec Section 11.3 step 4).
   */
  @IsNotEmpty()
  @IsString()
  reason: string;
}
