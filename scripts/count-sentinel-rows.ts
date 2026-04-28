/**
 * One-shot legacy sentinel counter for DB-W45-01 backfill decision + proof.
 * Read-only; exits 0 with the count on stdout.
 *
 * Retained through Wave 45 merge as post-run proof tooling: operators can
 * re-run this script after the next backend boot to confirm
 * `sentinel_rows: 0` (the BootstrapMigrationsService auto-backfill and the
 * canonical migration both converge on the same empty set).
 *
 * TODO: remove after Wave 45 merges and staging/prod have been observed
 * to report `sentinel_rows: 0` at steady state.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';

dotenv.config({
  path: path.resolve(
    __dirname,
    '..',
    `.env.${process.env.NODE_ENV ?? 'development'}`,
  ),
});

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? process.env.DB_DATABASE,
  });
  await client.connect();
  const res = await client.query(
    `SELECT COUNT(*)::int AS c
       FROM ai_executive_messages
      WHERE target_id = '00000000-0000-0000-0000-000000000000'
        AND endpoint = 'executive-chat'`,
  );
  const total = await client.query(
    `SELECT COUNT(*)::int AS c FROM ai_executive_messages WHERE endpoint = 'executive-chat'`,
  );
  console.log(`sentinel_rows: ${res.rows[0].c}`);
  console.log(`total_chat_rows: ${total.rows[0].c}`);
  await client.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
