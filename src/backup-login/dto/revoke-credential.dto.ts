import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RevokeCredentialDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}
