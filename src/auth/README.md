# `backend/src/auth/` — Canonical Role/Auth Pattern

This directory is the single source of truth for role-based admission on
NestJS controllers. If you need to gate an endpoint by role (and optionally
by `workStatus = approved` per CLAUDE.md §2), you MUST use the pattern
documented here. No other pattern is permitted.

The migration that retired the inline `assertX(req)` helpers is tracked in
`docs/tasks/auth-roles-guard-unification.md` and `docs/reports/auth-roles-guard-unification.md`.

---

## When to use this

Every NestJS controller endpoint that previously had any of:

- `assertAdmin(req)`
- `assertSuperAdmin(req)`
- `assertAdminOrAbove(req)`
- `assertReadAccess(req)`
- `assertExecRead(req)`

…or any inline `Set<string>` of role-name literals (`new Set(['admin', 'super-admin', ...])`)
inside a controller file. These are dead patterns. Reintroducing them is
caught by the ESLint guardrail in `eslint.config.mjs` (see
[CI guardrail](#ci-guardrail) below).

If you are writing a brand-new endpoint that needs a role gate, start here.
Do not invent a new helper.

---

## The canonical pattern

```ts
import { UseGuards, Patch, Param, Body } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { Role } from 'src/auth/roles.enum';
import { ADMIN_OR_ABOVE } from 'src/auth/role-groups';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_OR_ABOVE)
@Patch(':id')
update(@Param('id') id: string, @Body() dto: UpdateDto) {
  // handler runs only for admin / super-admin; req.user is populated.
}
```

Hard rules:

1. **`JwtAuthGuard` MUST come BEFORE `RolesGuard`** in the `@UseGuards(...)`
   array. `RolesGuard` reads `req.user.role` populated by the JWT strategy;
   reversing the order silently 403s every request because `req.user` is
   undefined. (See `roles.guard.spec.ts` test cases #6 / #7 — that is the
   deterministic failure mode.)
2. **`WorkStatusApprovedGuard` (if used) goes AFTER `RolesGuard`** —
   cheap token-claim role check first, live DB workStatus read second:
   `@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)`.
3. **Always pair `RolesGuard` with a `@Roles(...)` decorator.** A method
   missing `@Roles(...)` is a no-op (the guard returns `true`) — that is
   the opt-in default for incremental migration, NOT a security feature.
   Visual code review during PRs MUST confirm every formerly-gated method
   has the decorator.

---

## Picking the right group

Import constants from `src/auth/role-groups.ts` and spread them into
`@Roles(...)`. Use a literal list ONLY when no group fits.

| Group              | Members                                        | Use for                                                                     |
|--------------------|------------------------------------------------|-----------------------------------------------------------------------------|
| `STAFF_LEAD`       | `staff`, `admin`, `super-admin`                | Staff-controlled workflow transitions (review / verify / approve / staff-led rollback) per CLAUDE.md "Staff-Lead Definition" + §4.1. |
| `ADMIN_OR_ABOVE`   | `admin`, `super-admin`                         | Identity / WorkHistory mutation. Excludes `staff` (§4.1 — staff authority is project-scoped, not identity-scoped). SEC-01 P0 gates. |
| `SUPER_ADMIN_ONLY` | `super-admin`                                  | Destructive ops, PDPA-sensitive aggregates, force-unlink, alert CRUD writes. |
| `EXEC_READ`        | `staff`, `admin`, `super-admin`, `c-level`     | Executive read surfaces — AI exec chat, notification-alerts LIST (W98), notification-quota read. **Includes `staff`.** |
| `STATS_READ`       | `admin`, `super-admin`, `c-level`              | `system-usage` read endpoints. **Excludes `staff`** (SEC-01 Required Fix #5 — reusing `EXEC_READ` here is silent widening). |

For one-off shapes that don't match a group, use a literal list:

```ts
@Roles(Role.ADMIN, Role.C_LEVEL)
```

Do NOT define a new local `Set<string>` of role-name literals — that is the
exact pattern this directory replaced. If you find yourself wanting one,
add a new group to `role-groups.ts` instead and reuse it.

---

## Module wiring

`RolesGuard` is stateless (depends only on `Reflector`, which Nest provides
automatically). `WorkStatusApprovedGuard` is stateful — it injects
`Repository<WorkHistory>`.

For any module hosting a controller that uses `@Roles(...)`:

```ts
@Module({
  controllers: [MyController],
  providers: [..., RolesGuard],
})
export class MyModule {}
```

For any module hosting a controller that ALSO uses `WorkStatusApprovedGuard`:

```ts
@Module({
  imports: [TypeOrmModule.forFeature([WorkHistory])],   // REQUIRED
  controllers: [MyController],
  providers: [..., RolesGuard, WorkStatusApprovedGuard], // REQUIRED
})
export class MyModule {}
```

Do NOT register `RolesGuard` globally via `APP_GUARD`. The migration is
opt-in per controller so the blast radius of any misconfiguration is
bounded (per task §11 risk register).

---

## What NOT to do

- **Do NOT introduce `@SkipRoles()` / `@AllowAnonymous()` / any bypass
  decorator.** §17.11 forbids role exemption. There is no "super-admin
  override" path and there will never be one.
- **Do NOT live-read role from the database inside `RolesGuard`.** The
  canonical contract is token-cached `req.user.role` (per SEC-01 verdict
  §10). Live-reading workStatus is the job of the separate
  `WorkStatusApprovedGuard` and is narrowly scoped to §2.
- **Do NOT add inline `assertX(req)` helpers in new controllers.** This is
  the pattern this whole directory replaced. The ESLint guardrail flags
  `assertAdmin|assertSuperAdmin|assertAdminOrAbove|assertReadAccess|assertExecRead`
  in any `*.controller.ts` file.
- **Do NOT register `RolesGuard` globally via `APP_GUARD`.** Opt-in per
  controller only.
- **Do NOT lowercase-normalize roles inside `RolesGuard`.** Matching is
  case-sensitive against the canonical lowercase DB strings. Tokens MUST
  be issued with lowercase hyphenated role values; a mixed-case claim is
  treated as a mismatch and rejected (this is verified by
  `roles.guard.spec.ts` test #8). If a token-issuance bug ever introduces
  mixed-case roles, fix it at the JWT chokepoint (`JwtStrategy.validate`),
  not in the guard.
- **Do NOT define a controller-local `Set<string>` of role-name literals.**
  Add a group to `role-groups.ts` instead.
- **Do NOT use raw role strings (`'super-admin'`) in handler-level inline
  checks.** Compare against the `Role` enum (`Role.SUPER_ADMIN`) so a typo
  becomes a TS error, not a silent bypass. The mode-branched DELETE in
  `work-history.controller.ts` is the canonical example.

---

## Examples

### 1. Admin-only mutation (work-history style — SEC-01 P0)

```ts
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { ADMIN_OR_ABOVE } from 'src/auth/role-groups';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_OR_ABOVE)
@Post()
create(@Body() dto: CreateWorkHistoryDto) {
  return this.svc.create(dto);
}
```

### 2. Super-admin destructive (line-bindings force-unlink style)

```ts
import { SUPER_ADMIN_ONLY } from 'src/auth/role-groups';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...SUPER_ADMIN_ONLY)
@Post(':id/force-unlink')
forceUnlink(@Param('id') id: string) { /* ... */ }
```

### 3. Exec-read with workStatus enforcement (ai-executive-chat style)

```ts
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { EXEC_READ } from 'src/auth/role-groups';

@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
@Roles(...EXEC_READ)
@Get('conversations')
listConversations() { /* ... */ }
```

Three guards, in this exact order: cheap auth → cheap role gate → live
workStatus DB read.

---

## Reference: `STATS_READ` vs `EXEC_READ` pitfall (SEC-01 Required Fix #5)

`system-usage` read endpoints use `STATS_READ` (admin + super-admin + c-level)
NOT `EXEC_READ` (staff + admin + super-admin + c-level). Reusing `EXEC_READ`
on `system-usage` would silently add `staff` to the allow-list — a real
widening of access vs the pre-refactor `STATS_READ_ROLES` constant. This is
explicitly called out in `role-groups.ts` JSDoc and is the single pitfall
to be aware of when fanning out new statistics-read endpoints.

When in doubt, check the pre-refactor allow-list before picking a group.

---

## CI guardrail

`backend/eslint.config.mjs` carries a `no-restricted-syntax` rule scoped to
`**/*.controller.ts` that flags reintroduction of the role-gate helper
methods. The rule is targeted (it does NOT flag `assertForceUnlinkRateLimit`
or any other non-role-gate `assert*` helper).

The canonical helpers in `backend/src/auth/` itself are intentionally
unaffected by the rule (they live outside the `*.controller.ts` glob).
Test files (`*.spec.ts`) are also unaffected by the controller-only glob.

If you have a legitimate need to escape the rule (you almost certainly do
not), the only sanctioned path is to extend `role-groups.ts` with a new
canonical group and use `@Roles(...)`. There is no eslint-disable-line
exception list.

---

## See also

- `docs/tasks/auth-roles-guard-unification.md` — full task contract.
- `docs/reports/auth-roles-guard-unification.md` — DAG report (SEC-01,
  BE-01..BE-05 sections).
- `backend/src/auth/roles.guard.spec.ts` — guard behavior matrix.
- CLAUDE.md §2 (work status), §4.1 (ownership vs workflow authority),
  "Staff-Lead Definition", §17.11 (no role exemption).
