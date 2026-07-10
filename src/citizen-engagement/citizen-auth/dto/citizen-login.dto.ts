import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

/** AUTH-REDESIGN (2026-07-08) — citizen email/password login. */
export class CitizenLoginDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}
