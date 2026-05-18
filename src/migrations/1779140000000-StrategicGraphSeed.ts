import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 1 — Strategic Graph (DB-04)
 *
 * Seeds the four EXTERNAL strategic-alignment master tables created by
 * DB-01 (1779120000000-StrategicGraphMasterTables.ts). Runs AFTER DB-03
 * (1779130000000-StrategicGraphJunctions.ts) but writes ONLY to the
 * master tables — junctions remain empty until the user wires them via
 * the admin UI.
 *
 * Source of truth:
 *   - docs/tasks/STRATEGIC_GRAPH_UMBRELLA.md
 *   - DB-01 migration: 1779120000000-StrategicGraphMasterTables.ts
 *   - DB-03 migration: 1779130000000-StrategicGraphJunctions.ts
 *   - CLAUDE.md §10 (scope binding), §12 (audit — master/config seeds
 *     do NOT create TrackingStatus records)
 *
 * Locked decisions (user-confirmed 2026-05-18):
 *   - SDGs: 17 official UN goals (EN canonical, TH translation).
 *   - National Strategies: 6 pillars of Thailand 20-year National
 *     Strategy 2018-2037.
 *   - Milestones: 13 หมุดหมาย from Plan 13 (TH only; EN NULL per spec).
 *   - Province Strategies: 1 placeholder row — user fills via admin UI.
 *   - All seeds use is_active = true.
 *   - id is auto-generated via DEFAULT gen_random_uuid() from DB-01.
 *   - created_at / updated_at are auto-populated via DEFAULT NOW().
 *
 * Idempotency strategy:
 *   DB-01 deliberately kept `code` non-unique (plain b-tree index,
 *   nullable). To avoid altering that constraint contract, this
 *   migration uses an `INSERT ... SELECT ... WHERE NOT EXISTS` pattern
 *   keyed on `code`. Re-running the migration is a no-op once the
 *   canonical seed codes already exist; user-added rows (different
 *   codes, or NULL code) are untouched on both up() and down().
 *
 * §14 / §15 / §16 / §17 interaction: orthogonal. These rows are
 * MASTER/CONFIG reference data; they do not gate workflow transitions,
 * lock lineages, branch on reportFormat, or interact with AI.
 */
export class StrategicGraphSeed1779140000000 implements MigrationInterface {
  name = 'StrategicGraphSeed1779140000000';

  // ---------------------------------------------------------------------------
  // Canonical seed data — frozen per user direction 2026-05-18.
  // ---------------------------------------------------------------------------

  private readonly SDGS: ReadonlyArray<{
    code: string;
    name_th: string;
    name_en: string;
  }> = [
    { code: 'SDG1', name_th: 'ขจัดความยากจน', name_en: 'No Poverty' },
    { code: 'SDG2', name_th: 'ขจัดความหิวโหย', name_en: 'Zero Hunger' },
    {
      code: 'SDG3',
      name_th: 'มีสุขภาพและความเป็นอยู่ที่ดี',
      name_en: 'Good Health and Well-being',
    },
    {
      code: 'SDG4',
      name_th: 'การศึกษาที่มีคุณภาพ',
      name_en: 'Quality Education',
    },
    {
      code: 'SDG5',
      name_th: 'ความเท่าเทียมทางเพศ',
      name_en: 'Gender Equality',
    },
    {
      code: 'SDG6',
      name_th: 'การจัดการน้ำและสุขาภิบาล',
      name_en: 'Clean Water and Sanitation',
    },
    {
      code: 'SDG7',
      name_th: 'พลังงานสะอาดที่ทุกคนเข้าถึงได้',
      name_en: 'Affordable and Clean Energy',
    },
    {
      code: 'SDG8',
      name_th: 'การจ้างงานที่มีคุณค่าและการเติบโตทางเศรษฐกิจ',
      name_en: 'Decent Work and Economic Growth',
    },
    {
      code: 'SDG9',
      name_th: 'อุตสาหกรรม นวัตกรรม โครงสร้างพื้นฐาน',
      name_en: 'Industry, Innovation and Infrastructure',
    },
    {
      code: 'SDG10',
      name_th: 'ลดความเหลื่อมล้ำ',
      name_en: 'Reduced Inequalities',
    },
    {
      code: 'SDG11',
      name_th: 'เมืองและถิ่นฐานมนุษย์อย่างยั่งยืน',
      name_en: 'Sustainable Cities and Communities',
    },
    {
      code: 'SDG12',
      name_th: 'แผนการบริโภคและการผลิตที่ยั่งยืน',
      name_en: 'Responsible Consumption and Production',
    },
    {
      code: 'SDG13',
      name_th: 'การรับมือการเปลี่ยนแปลงสภาพภูมิอากาศ',
      name_en: 'Climate Action',
    },
    {
      code: 'SDG14',
      name_th: 'การใช้ประโยชน์จากมหาสมุทรและทรัพยากรทางทะเล',
      name_en: 'Life Below Water',
    },
    {
      code: 'SDG15',
      name_th: 'การใช้ประโยชน์จากระบบนิเวศทางบก',
      name_en: 'Life on Land',
    },
    {
      code: 'SDG16',
      name_th: 'สังคมสงบสุข ยุติธรรม ไม่แบ่งแยก',
      name_en: 'Peace, Justice and Strong Institutions',
    },
    {
      code: 'SDG17',
      name_th: 'ความร่วมมือเพื่อการพัฒนาที่ยั่งยืน',
      name_en: 'Partnerships for the Goals',
    },
  ];

  private readonly NATIONAL_STRATEGIES: ReadonlyArray<{
    code: string;
    name_th: string;
    name_en: string;
  }> = [
    {
      code: 'NS1',
      name_th: 'ยุทธศาสตร์ชาติด้านความมั่นคง',
      name_en: 'Security',
    },
    {
      code: 'NS2',
      name_th:
        'ยุทธศาสตร์ชาติด้านการสร้างความสามารถในการแข่งขัน',
      name_en: 'Competitiveness Enhancement',
    },
    {
      code: 'NS3',
      name_th:
        'ยุทธศาสตร์ชาติด้านการพัฒนาและเสริมสร้างศักยภาพทรัพยากรมนุษย์',
      name_en: 'Human Resource Development',
    },
    {
      code: 'NS4',
      name_th:
        'ยุทธศาสตร์ชาติด้านการสร้างโอกาสและความเสมอภาคทางสังคม',
      name_en: 'Social Cohesion and Equity',
    },
    {
      code: 'NS5',
      name_th:
        'ยุทธศาสตร์ชาติด้านการสร้างการเติบโตบนคุณภาพชีวิตที่เป็นมิตรกับสิ่งแวดล้อม',
      name_en: 'Environmentally Friendly Growth',
    },
    {
      code: 'NS6',
      name_th:
        'ยุทธศาสตร์ชาติด้านการปรับสมดุลและพัฒนาระบบการบริหารจัดการภาครัฐ',
      name_en: 'Public Sector Rebalancing and Reform',
    },
  ];

  // Milestones — Thai-only per spec (name_en = NULL).
  private readonly MILESTONES: ReadonlyArray<{
    code: string;
    name_th: string;
  }> = [
    { code: 'MS1', name_th: 'เกษตรและเกษตรแปรรูปมูลค่าสูง' },
    { code: 'MS2', name_th: 'การท่องเที่ยวเน้นคุณค่าและความยั่งยืน' },
    { code: 'MS3', name_th: 'ฐานการผลิตยานยนต์ไฟฟ้า' },
    { code: 'MS4', name_th: 'การแพทย์และสุขภาพครบวงจร' },
    {
      code: 'MS5',
      name_th: 'ประตูการค้าการลงทุนและยุทธศาสตร์ทางโลจิสติกส์',
    },
    { code: 'MS6', name_th: 'อิเล็กทรอนิกส์อัจฉริยะและบริการดิจิทัล' },
    { code: 'MS7', name_th: 'SMEs ที่เข้มแข็งและเศรษฐกิจฐานราก' },
    { code: 'MS8', name_th: 'พื้นที่และเมืองอัจฉริยะที่น่าอยู่' },
    {
      code: 'MS9',
      name_th: 'ความยากจนข้ามรุ่นและความคุ้มครองทางสังคม',
    },
    { code: 'MS10', name_th: 'เศรษฐกิจหมุนเวียนและสังคมคาร์บอนต่ำ' },
    {
      code: 'MS11',
      name_th:
        'การลดความเสี่ยงจากภัยธรรมชาติและการเปลี่ยนแปลงสภาพภูมิอากาศ',
    },
    {
      code: 'MS12',
      name_th: 'กำลังคนสมรรถนะสูงตอบโจทย์การพัฒนาประเทศ',
    },
    {
      code: 'MS13',
      name_th: 'ภาครัฐที่ทันสมัย มีประสิทธิภาพ ตอบโจทย์ประชาชน',
    },
  ];

  // Province Strategies — 1 placeholder; user fills via admin UI.
  private readonly PROVINCE_STRATEGIES: ReadonlyArray<{
    code: string;
    name_th: string;
  }> = [
    {
      code: 'PS_PLACEHOLDER',
      name_th: 'ยุทธศาสตร์จังหวัด (โปรดเพิ่มผ่านหน้าจอจัดการ)',
    },
  ];

  // ---------------------------------------------------------------------------
  // up()
  // ---------------------------------------------------------------------------

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) SDGs — 17 rows, EN + TH
    for (const row of this.SDGS) {
      await queryRunner.query(
        `INSERT INTO sdgs (code, name_th, name_en, is_active)
         SELECT $1, $2, $3, true
         WHERE NOT EXISTS (SELECT 1 FROM sdgs WHERE code = $1)`,
        [row.code, row.name_th, row.name_en],
      );
    }

    // 2) National Strategies — 6 rows, EN + TH
    for (const row of this.NATIONAL_STRATEGIES) {
      await queryRunner.query(
        `INSERT INTO national_strategies (code, name_th, name_en, is_active)
         SELECT $1, $2, $3, true
         WHERE NOT EXISTS (SELECT 1 FROM national_strategies WHERE code = $1)`,
        [row.code, row.name_th, row.name_en],
      );
    }

    // 3) Milestones — 13 rows, TH only (name_en stays NULL)
    for (const row of this.MILESTONES) {
      await queryRunner.query(
        `INSERT INTO milestones (code, name_th, is_active)
         SELECT $1, $2, true
         WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE code = $1)`,
        [row.code, row.name_th],
      );
    }

    // 4) Province Strategies — 1 placeholder
    for (const row of this.PROVINCE_STRATEGIES) {
      await queryRunner.query(
        `INSERT INTO province_strategies (code, name_th, is_active)
         SELECT $1, $2, true
         WHERE NOT EXISTS (SELECT 1 FROM province_strategies WHERE code = $1)`,
        [row.code, row.name_th],
      );
    }
  }

  // ---------------------------------------------------------------------------
  // down()
  // ---------------------------------------------------------------------------

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Delete ONLY the canonical seed codes — preserves any user-added rows
    // (different codes, NULL codes, or admin-UI additions).
    //
    // ON DELETE RESTRICT on the DB-03 junction FKs means these DELETEs will
    // fail loudly if the user has already wired a seed master row into a
    // junction. That is the intended safeguard — the operator must
    // unwire / soft-deactivate mappings before reverting this seed.

    const sdgCodes = this.SDGS.map((r) => r.code);
    await queryRunner.query(
      `DELETE FROM sdgs WHERE code = ANY($1::varchar[])`,
      [sdgCodes],
    );

    const nsCodes = this.NATIONAL_STRATEGIES.map((r) => r.code);
    await queryRunner.query(
      `DELETE FROM national_strategies WHERE code = ANY($1::varchar[])`,
      [nsCodes],
    );

    const msCodes = this.MILESTONES.map((r) => r.code);
    await queryRunner.query(
      `DELETE FROM milestones WHERE code = ANY($1::varchar[])`,
      [msCodes],
    );

    const psCodes = this.PROVINCE_STRATEGIES.map((r) => r.code);
    await queryRunner.query(
      `DELETE FROM province_strategies WHERE code = ANY($1::varchar[])`,
      [psCodes],
    );
  }
}
