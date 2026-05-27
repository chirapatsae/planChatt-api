import { IsString, Length } from 'class-validator';

export class TotpEnrollCompleteDto {
  @IsString()
  @Length(6, 6)
  totpCode: string;
}
