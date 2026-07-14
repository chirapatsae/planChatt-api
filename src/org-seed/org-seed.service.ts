import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * OrgSeedService — guarantees the SINGLE home organization exists on boot.
 *
 * planChatt was rescoped (2026-07) from a province-wide system (many อำเภอ ×
 * many อปท. under อบจ.นครราชสีมา) down to ONE อปท: เทศบาลตำบลหนองกระทุ่ม,
 * อำเภอเมือง. The whole codebase already treats the pair
 * (amphoe '3001', lao '3001027') as the privileged "home / agency" org that
 * unlocks every feature — see `AGENCY_AMPHOE_ID` / `AGENCY_LAO_ID` in
 * `common/supplement-scope/supplement-scope.service.ts` and the ~40 sites that
 * hardcode '3001027'. หนองกระทุ่ม already lives in amphoe 3001, so keeping that
 * pair (renamed to หนองกระทุ่ม) means the single-LAO deployment reuses the
 * existing structure with no logic change.
 *
 * Base data (amphoes / LAOs / roles / work_status) is otherwise loaded
 * OUT-OF-BAND (there is no CSV importer in code), and the ~300 member LAOs are
 * intentionally NOT loaded in the single-LAO deployment. This service is the
 * in-repo, idempotent guarantee for the two rows that MUST exist for the app to
 * function, so a green-field DB needs no manual SQL for them.
 *
 * ENFORCING UPSERT (`ON CONFLICT (id) DO UPDATE`): the LAO table is the single
 * source of truth for the home-org identity (owner decision 2026-07-12), so
 * boot GUARANTEES row 3001027 carries the canonical name/type — this repairs
 * the pre-rescope province DB where 3001027 was still named
 * "องค์การบริหารส่วนจังหวัดนครราชสีมา" (the old create-only seed could not
 * rename it, which is why the UI/AI kept showing "อบจ.นม"). A deliberate
 * rename goes through the ORG_* env vars, never ad-hoc edits. Mirrors
 * `BackupLoginBootstrapService`: runs on `onApplicationBootstrap` and NEVER
 * crashes boot on a seed hiccup.
 */
@Injectable()
export class OrgSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgSeedService.name);

  private readonly amphoeId = process.env.ORG_AMPHOE_ID?.trim() || '3001';
  private readonly amphoeName =
    process.env.ORG_AMPHOE_NAME?.trim() || 'เมืองนครราชสีมา';
  private readonly laoId = process.env.ORG_LAO_ID?.trim() || '3001027';
  private readonly laoName =
    process.env.ORG_LAO_NAME?.trim() || 'เทศบาลตำบลหนองกระทุ่ม';
  private readonly laoType = process.env.ORG_LAO_TYPE?.trim() || 'เทศบาลตำบล';

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Defensive: a test harness may inject an uninitialized stub.
    if (!this.dataSource?.isInitialized) {
      this.logger.warn(
        '[OrgSeed] DataSource not initialized; skipping home-org seed.',
      );
      return;
    }

    try {
      // Amphoe first — LAO.amphoe_id is a FK to amphoes.id.
      await this.dataSource.query(
        `INSERT INTO amphoes (id, name)
           VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name`,
        [this.amphoeId, this.amphoeName],
      );
      await this.dataSource.query(
        `INSERT INTO local_administrative_organizations (id, name, type, amphoe_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 type = EXCLUDED.type,
                 amphoe_id = EXCLUDED.amphoe_id`,
        [this.laoId, this.laoName, this.laoType, this.amphoeId],
      );
      this.logger.log(
        `[OrgSeed] home org enforced — amphoe ${this.amphoeId}="${this.amphoeName}", ` +
          `lao ${this.laoId}="${this.laoName}" (${this.laoType}).`,
      );
    } catch (err) {
      // Never block boot. A likely-but-benign cause is a UNIQUE(name)
      // collision if a DIFFERENT id already holds the name (e.g. a migrated
      // province DB) — in that case the operator resolves the rename manually.
      this.logger.error(
        `[OrgSeed] home-org seed failed (not crashing app): ${(err as Error).message}`,
      );
    }
  }
}
