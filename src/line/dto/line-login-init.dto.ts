/**
 * line-login-init.dto.ts — Wave 86 LINE Login OAuth initiate response.
 *
 * The /initiate endpoint takes no body — the caller is identified by
 * the JWT bearer token. The response carries the authorize URL the
 * frontend should 302-redirect (or window.location.assign) the user to.
 *
 * Per CLAUDE.md §17.10 / W83 Logger discipline: this DTO MUST NOT carry
 * the raw state/nonce values back to the client. They are stored
 * server-side in the in-memory state store keyed by the random `state`,
 * and `state` is embedded in the authorize URL only.
 */
export class LineLoginInitiateResponseDto {
  /**
   * Fully-formed LINE OAuth 2.1 authorize URL with response_type=code,
   * client_id, redirect_uri, state, nonce, scope=openid+profile.
   */
  authorizeUrl: string;
}
