import { IsNotEmpty, IsString } from 'class-validator';

/**
 * AUTH-REDESIGN (2026-07-08) — citizen "Login with Google".
 * The FE (Google Identity Services) obtains an ID token and posts it here.
 * The BE verifies it against Google's JWKS via `google-auth-library`
 * (NOT decode-only). See docs/AUTH-REDESIGN.md §4.4.
 */
export class CitizenGoogleLoginDto {
  @IsString()
  @IsNotEmpty()
  idToken: string;
}
