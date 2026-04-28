import { Module } from '@nestjs/common';
import { BootstrapMigrationsService } from './bootstrap-migrations.service';

/**
 * BootstrapModule — Wave 44 DB-W44-02.
 *
 * Hosts startup-only services that must run after the global
 * DataSource is initialized but BEFORE any HTTP request handler is
 * reachable. Nest's `onApplicationBootstrap` lifecycle guarantees
 * that ordering.
 *
 * The module intentionally declares no controllers and exports
 * nothing — the hook runs for its side effect (corrective DDL) and is
 * not consumed by any other module.
 *
 * See `docs/tasks/wave44/DB-W44-02.md` for scope and governance.
 */
@Module({
  providers: [BootstrapMigrationsService],
})
export class BootstrapModule {}
