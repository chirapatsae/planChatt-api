import { IsBoolean, IsNotEmpty, IsString, Matches } from 'class-validator';

export class CancelBookDto {
  /**
   * Explicit confirmation flag — operator must send true to proceed (Spec Section 11.3 step 2).
   */
  @IsBoolean()
  confirmed: boolean;

  /**
   * Last 6 digits of the operator's national ID card number (Spec Section 11.3 step 3).
   * Used for secondary authorization — raw value is NEVER stored.
   * Only the last 2 digits appear in audit records as ****XX.
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'citizenIdSuffix must be exactly 6 digits' })
  citizenIdSuffix: string;

  /**
   * Human-readable reason for cancellation (Spec Section 11.3 step 4).
   */
  @IsNotEmpty()
  @IsString()
  reason: string;
}
