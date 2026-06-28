/**
 * Public response shape for an official response on a citizen post (C4, D12).
 *
 * PII guard: exposes ONLY the SNAPSHOT display/agency name captured at response
 * time — never a national id / `*_enc` / any users/work_history row content
 * (§17.3). The responder's plain uuids are intentionally NOT exposed.
 */
export interface OfficialResponseDto {
  id: string;
  body: string;
  responderDisplayName: string;
  responderAgencyName: string | null;
  createdAt: string;
  // W-G2: issue-handling status lifecycle (`received` | `in_progress` |
  // `resolved`) + the timestamp of the last forward transition (null until the
  // first advance). Advisory display state (§17.2) — never a project workflow
  // status. Surfaces wherever an official response is rendered (post detail).
  status: string;
  statusUpdatedAt: string | null;
}
