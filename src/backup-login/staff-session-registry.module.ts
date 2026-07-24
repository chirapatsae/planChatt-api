import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StaffSession } from './entities/staff-session.entity';
import { StaffSessionRegistryService } from './staff-session-registry.service';

/**
 * StaffSessionRegistryModule — makes `StaffSessionRegistryService` injectable
 * app-wide.
 *
 * WHY @Global: the staff `JwtAuthGuard` (`src/auth/auth.guard.ts`) is referenced
 * by ~40 feature modules via `@UseGuards(JwtAuthGuard)`. Nest instantiates the
 * guard in each consuming module's injector, so any dependency it adds MUST be
 * resolvable everywhere. `DataSource` already works because TypeORM's core
 * module is global; the session-registry service must be too, or every one of
 * those modules would fail to resolve the guard at boot. Exporting it from a
 * single `@Global()` module (imported once in AppModule) mirrors that posture
 * without a per-module import.
 *
 * The `forFeature([StaffSession])` repo stays module-internal; only the SERVICE
 * is exported. `StaffSession` is ALSO registered in the root `entities[]` array
 * (app.module.ts) — the Wave-41 explicit-entities footgun.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([StaffSession])],
  providers: [StaffSessionRegistryService],
  exports: [StaffSessionRegistryService],
})
export class StaffSessionRegistryModule {}
