import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResetCredentialDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}
