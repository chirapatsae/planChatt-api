/**
 * verify-ai-executive-messages-nullable.ts — Wave 45 DB-W45-01
 *
 * Pre-flight nullability gate for BE-W45-01.
 *
 * Purpose
 * -------
 * BE-W45-01 replaces the Wave 44 HOTFIX-W44-01 sentinel write path for
 * `ai_executive_messages.target_id` + `.target_kind` with a tool-aware
 * data-driven capture that INSERTs real NULL on non-project-scoped chat
 * turns. That INSERT will 500 (NOT NULL violation) unless BOTH columns
 * are physically `is_nullable = 'YES'` in the target database.
 *
 * This script is the READ-ONLY probe that proves the nullability state.
 * It MUST exit 0 on every environment BEFORE BE-W45-01 ships.
 *
 * Contract
 * --------
 * - No Nest bootstrap, no entity metadata. Just a raw `pg` client using
 *   `DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_NAME` from the
 *   same `.env.${NODE_ENV}` / `.env` fallback chain the app uses.
 * - Queries ONLY `information_schema.columns`. Requires regular SELECT
 *   privileges; no elevated role needed. NEVER writes.
 * - Exit 0 + `[DB-W45-01] ai_executive_messages target columns nullable: OK`
 *   when both columns are `is_nullable = 'YES'`.
 * - Exit 1 + `[DB-W45-01] ai_executive_messages <col> is_nullable=NO — BE-W45-01 BLOCKED`
 *   on any failure (including missing table, missing column, wrong value,
 *   or connection error).
 *
 * Governance (CLAUDE.md)
 * ----------------------
 * - §17.3 audit separation — this script NEVER writes to `tracking_status`,
 *   NEVER mutates `ai_*` rows, NEVER adds or touches any FK.
 * - §17.11 no role exemption — this is an integrity probe, not a
 *   permission check. No role can bypass its signal.
 *
 * Usage
 * -----
 *   npm run db:verify:ai-exec-nullable
 *     # or
 *   NODE_ENV=development ts-node -T backend/scripts/verify-ai-executive-messages-nullable.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Client } from 'pg';

const SCRIPT_TAG = '[DB-W45-01]';

function loadEnv(): void {
  // Mirror `src/util/encryption.util.ts` env loader so the script works
  // from any CWD (typically `backend/` when run via npm script).
  const nodeEnv = process.env.NODE_ENV || 'development';
  const candidates = [
    path.resolve(process.cwd(), `.env.${nodeEnv}`),
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', `.env.${nodeEnv}`),
    path.resolve(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }
  // Not fatal — env vars may be supplied by the shell directly (CI).
}

interface ColumnRow {
  column_name: string;
  is_nullable: 'YES' | 'NO';
}

async function main(): Promise<number> {
  loadEnv();

  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT) || 5432;
  const user = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  if (!host || !user || !database) {
    console.error(
      `${SCRIPT_TAG} missing DB_HOST / DB_USERNAME / DB_NAME — cannot probe. BE-W45-01 BLOCKED`,
    );
    return 1;
  }

  const client = new Client({
    host,
    port,
    user,
    password,
    database,
    // Keep timeouts tight — this is a pre-flight probe.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });

  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${SCRIPT_TAG} failed to connect to ${host}:${port}/${database} — ${msg}. BE-W45-01 BLOCKED`,
    );
    return 1;
  }

  try {
    const result = await client.query<ColumnRow>(
      `
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'ai_executive_messages'
          AND column_name IN ('target_id', 'target_kind')
      `,
    );

    const rowsByName: Record<string, ColumnRow> = {};
    for (const row of result.rows) {
      rowsByName[row.column_name] = row;
    }

    const failures: string[] = [];
    for (const col of ['target_id', 'target_kind']) {
      const row = rowsByName[col];
      if (!row) {
        failures.push(
          `${SCRIPT_TAG} ai_executive_messages.${col} MISSING from information_schema — BE-W45-01 BLOCKED`,
        );
        continue;
      }
      if (row.is_nullable !== 'YES') {
        failures.push(
          `${SCRIPT_TAG} ai_executive_messages.${col} is_nullable=${row.is_nullable} — BE-W45-01 BLOCKED`,
        );
      }
    }

    if (failures.length > 0) {
      for (const line of failures) console.error(line);
      return 1;
    }

    console.log(
      `${SCRIPT_TAG} ai_executive_messages target columns nullable: OK`,
    );
    console.log(
      `${SCRIPT_TAG} target_id.is_nullable=${rowsByName.target_id.is_nullable}, target_kind.is_nullable=${rowsByName.target_kind.is_nullable}`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${SCRIPT_TAG} information_schema query failed — ${msg}. BE-W45-01 BLOCKED`,
    );
    return 1;
  } finally {
    await client.end().catch(() => {
      /* best-effort; probe result already decided */
    });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${SCRIPT_TAG} unexpected failure — ${msg}. BE-W45-01 BLOCKED`);
    process.exit(1);
  });
