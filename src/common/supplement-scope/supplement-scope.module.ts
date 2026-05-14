import { Module } from '@nestjs/common';
import { SupplementScopeService } from './supplement-scope.service';
import { WorkHistoryModule } from 'src/work-history/work-history.module';

/**
 * SupplementScopeModule — SUPP-1 BE-04
 *
 * Provides the canonical owner-scope gate (§1 + §2) for every SPG
 * owner-scoped endpoint. Other SPG-related modules (BE-01 SPG service,
 * BE-02 tracking-status SPG branch, BE-03 owner-query) import this
 * module to obtain `SupplementScopeService`.
 *
 * Depends on `WorkHistoryModule` for `WorkHistoryLookupService`
 * (re-used to delegate the §2 workStatus check). Importing the work
 * history module here does NOT create circular dependencies — work
 * history has no inverse dependency on supplement.
 */
@Module({
  imports: [WorkHistoryModule],
  providers: [SupplementScopeService],
  exports: [SupplementScopeService],
})
export class SupplementScopeModule {}
