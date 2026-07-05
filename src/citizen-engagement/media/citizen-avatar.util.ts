/**
 * citizenAvatarUrl — build the public, cache-busted URL for a citizen's profile
 * photo, or null when they have none (FE falls back to the gradient+initial).
 *
 * The `?v=<updatedAt>` query changes whenever the identity row is saved (a new
 * upload bumps `updated_at`), so a freshly-uploaded photo is fetched instead of
 * a stale cached one.
 *
 * Returned path is AXIOS-RELATIVE (no `/api/v1` prefix, no origin) — it matches
 * the FE api client's path style; the FE prepends `VITE_API_BASE_URL` to build
 * the `<img src>`. §17.3 — the served endpoint is public (avatars are public,
 * like post media); the URL exposes only the opaque identity id, never a
 * storage/disk path.
 */
export function citizenAvatarUrl(
  id: string,
  avatarPath: string | null | undefined,
  updatedAt?: Date | string | null,
): string | null {
  if (!avatarPath) return null;
  const v = updatedAt ? new Date(updatedAt).getTime() : 0;
  return `/citizen-engagement/citizens/${id}/avatar?v=${v}`;
}
