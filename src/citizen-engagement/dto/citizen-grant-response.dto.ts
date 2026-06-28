/**
 * Public response shape for the backend-access grant console (C4, plan D6).
 *
 * PII guard: exposes ONLY the plain `userId` / `decidedByWorkHistoryId` uuids
 * and the grant lifecycle — never any users/work_history row content (§17.3).
 */
export interface GrantDto {
  id: string;
  userId: string;
  capability: string;
  state: string;
  decidedByWorkHistoryId: string | null;
  decidedAt: string | null;
  createdAt: string;
}
