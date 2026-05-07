// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      ecmaVersion: 5,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn'
    },
  },
  /**
   * auth-roles-guard-unification BE-05 (Phase 4 codified convention).
   *
   * Forbid reintroduction of the inline role-gate helper methods that
   * the auth-roles-guard-unification migration retired. The canonical
   * pattern is `@UseGuards(JwtAuthGuard, RolesGuard) + @Roles(...GROUP)`
   * — see `backend/src/auth/README.md`.
   *
   * Scope is INTENTIONAL:
   *   - applies ONLY to `**\/*.controller.ts` files; the canonical
   *     helpers in `backend/src/auth/` and the spec files are unaffected
   *   - the regex matches ONLY the five role-gate names; non-role
   *     `assert*` helpers (e.g. `assertForceUnlinkRateLimit`) are NOT
   *     flagged
   *
   * §17.11 — there is no `@SkipRoles` and no eslint-disable allow-list
   * for this rule. If a legitimate new shape arises, extend
   * `src/auth/role-groups.ts` with a new canonical group instead.
   */
  {
    files: ['**/*.controller.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MethodDefinition[key.name=/^assert(Admin|SuperAdmin|AdminOrAbove|ReadAccess|ExecRead)$/]",
          message:
            'Inline role-gate helpers (assertAdmin / assertSuperAdmin / assertAdminOrAbove / assertReadAccess / assertExecRead) are forbidden. Use @UseGuards(JwtAuthGuard, RolesGuard) + @Roles(...GROUP) — see backend/src/auth/README.md.',
        },
        {
          selector:
            "FunctionDeclaration[id.name=/^assert(Admin|SuperAdmin|AdminOrAbove|ReadAccess|ExecRead)$/]",
          message:
            'Inline role-gate helpers (assertAdmin / assertSuperAdmin / assertAdminOrAbove / assertReadAccess / assertExecRead) are forbidden. Use @UseGuards(JwtAuthGuard, RolesGuard) + @Roles(...GROUP) — see backend/src/auth/README.md.',
        },
      ],
    },
  },
);