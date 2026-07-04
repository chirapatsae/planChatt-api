/**
 * backfill-citizen-idea-amphoe.ts — one-off backfill of `citizen_post.amphoe_id`
 * for existing idea posts that were created before the amphoe was derived from
 * the pin. Uses the SAME point-in-polygon resolver as the create path
 * (`GeoBoundaryService.resolveAmphoeForPoint`), so backfilled values match what
 * a fresh create would produce.
 *
 * Usage:
 *   npx ts-node -T scripts/backfill-citizen-idea-amphoe.ts
 *
 * §17.2 advisory / §17.3 isolation — writes ONLY `citizen_post.amphoe_id`
 * (a code string like "3001"); touches no project table, no tracking_status.
 * Idempotent: re-running only fills rows still NULL (already-filled rows are
 * skipped by the WHERE clause).
 */
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource, IsNull } from 'typeorm';

import { AppModule } from '../src/app.module';
import { GeoBoundaryService } from '../src/ai/geo-boundary.service';
import { CitizenPost } from '../src/citizen-engagement/entities/citizen-post.entity';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const ds = app.get(DataSource);
    const geo = app.get(GeoBoundaryService);
    const repo = ds.getRepository(CitizenPost);

    const posts = await repo.find({
      where: { postKind: 'idea', amphoeId: IsNull() },
      select: ['id', 'lat', 'lng'],
    });

    let updated = 0;
    let noGeo = 0;
    let outside = 0;
    for (const p of posts) {
      if (p.lat == null || p.lng == null) {
        noGeo++;
        continue;
      }
      const code =
        geo.resolveAmphoeForPoint(Number(p.lat), Number(p.lng))?.amphoeCode ??
        null;
      if (!code) {
        outside++;
        continue;
      }
      await repo.update({ id: p.id }, { amphoeId: code });
      updated++;
    }

    console.log(
      JSON.stringify(
        { candidates: posts.length, updated, noGeo, outside },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
