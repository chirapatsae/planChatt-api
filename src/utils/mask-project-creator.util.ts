/**
 * Wave 100 PR2 — Shared decrypt-then-mask helper for project trees.
 *
 * Extracted from `ProjectGroupsService.maskCreatedByUserOnProjects` (PR1)
 * so that `RevisedProjectGroupService` and `SupplementProjectGroupService`
 * can reuse the same masking behavior on every list / detail / lineage
 * read path that surfaces a `createdBy.user` (and optionally a
 * `trackingStatus[].createdBy.user`) tree.
 *
 * Walks any object that exposes a `createdBy?.user` shape and (optionally)
 * a `trackingStatus[]` collection of the same shape, so the helper is
 * project-type-agnostic — it works uniformly on `ProjectGroup`,
 * `RevisedProjectGroup`, and `SupplementProjectGroup` instances.
 *
 * Behavior:
 *   1. `usersService.decryptUserPii(user)` — idempotent post-W89B; safe
 *      on already-decrypted users.
 *   2. Replace `user.email` with `maskEmail(user.email)` (or `null` when
 *      email was undefined / missing).
 *   3. Null `user.phone` and `user.citizenId` per W100 default #5.
 *
 * Idempotent + WeakSet-deduped — the same `User` instance is decrypted /
 * masked at most once per request even when it appears as `createdBy` on
 * many rows AND as a tracking-status actor on the same row.
 *
 * CLAUDE.md cross-refs:
 *   - §12  — read-only; no `tracking_status` writes
 *   - §17.2 — masking is integrity-bound, not a permission
 *   - §17.3 — AI audit isolation untouched (no AI tables touched)
 */
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';

interface MaskableProjectLike {
  createdBy?: { user?: User } | null;
  trackingStatus?: Array<{ createdBy?: { user?: User } | null }> | null;
}

export async function maskCreatedByUserOnProjects(
  usersService: UsersService,
  items:
    | Array<MaskableProjectLike | null | undefined>
    | MaskableProjectLike
    | null
    | undefined,
): Promise<void> {
  if (!items) return;
  const list = Array.isArray(items) ? items : [items];
  const seen = new WeakSet<object>();
  const visit = async (user: User | null | undefined) => {
    if (!user || seen.has(user)) return;
    seen.add(user);
    await usersService.decryptUserPii(user);
    user.email = user.email ? maskEmail(user.email) : (null as unknown as string);
    user.phone = null as unknown as string;
    user.citizenId = null as unknown as string;
  };
  for (const item of list) {
    if (!item) continue;
    await visit(item.createdBy?.user);
    const ts = item.trackingStatus;
    if (Array.isArray(ts)) {
      for (const t of ts) {
        await visit(t?.createdBy?.user);
      }
    }
  }
}
