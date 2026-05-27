import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * SECURITY-01 §7.2 — username is the lowercased email; password capped
 * 128 chars (defeats DoS via huge input).
 */
export class BackupLoginInitDto {
  @IsString()
  @MaxLength(256)
  username: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}
