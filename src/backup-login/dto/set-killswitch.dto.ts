import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetKillSwitchDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}
