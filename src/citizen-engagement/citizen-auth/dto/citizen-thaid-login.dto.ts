import { IsString } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/auth/thaid-login`.
 *
 * Same shape principle as the staff `CreateAuthDto.id_token` — the FE supplies
 * the ThaID-issued id_token; the BE decodes + validates `iss` (citizen-auth.service).
 */
export class CitizenThaidLoginDto {
  @IsString()
  id_token: string;
}
