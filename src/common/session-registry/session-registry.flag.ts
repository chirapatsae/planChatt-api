/**
 * Feature flag for the per-session registry + per-session revocation
 * (login-alerts / device-session-management).
 *
 * OFF by default: enforcement is a no-op unless `SESSION_REGISTRY_ENABLED`
 * is EXACTLY the string `'true'`. Any other value (unset, `'false'`, `'1'`,
 * `'TRUE'`, etc.) leaves live login behavior UNCHANGED — the citizen JWT
 * strategy + staff auth guard simply ignore the `sid` claim and fall back to
 * the pre-existing `session_version`-only checks (legacy / flag-off safety).
 *
 * Read at call time (not cached) so the flag can be flipped by restart without
 * a code change, and so tests can toggle it via `process.env`.
 */
export function sessionRegistryEnabled(): boolean {
  return process.env.SESSION_REGISTRY_ENABLED === 'true';
}
