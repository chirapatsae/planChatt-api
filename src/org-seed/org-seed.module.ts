import { Module } from '@nestjs/common';
import { OrgSeedService } from './org-seed.service';

/**
 * OrgSeedModule — single-LAO home-org seed (2026-07 rescope).
 *
 * Hosts the boot-time hook that guarantees the one amphoe + one LAO
 * (เทศบาลตำบลหนองกระทุ่ม) the app depends on. Declares no controllers and
 * exports nothing — the hook runs for its side effect only. See
 * `org-seed.service.ts` for scope and governance.
 */
@Module({
  providers: [OrgSeedService],
})
export class OrgSeedModule {}
