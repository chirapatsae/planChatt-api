import {
  IssueRuleEntry,
} from './issue-criteria.types';

/**
 * NAKHON RATCHASIMA — ISSUE_BASED criteria registry (Wave 24).
 *
 * Source: อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่น
 * แบบบูรณาการ (4 ประเด็นการพัฒนา), as transcribed into
 * `docs/architecture/ISSUE_BASED_CRITERIA.md` §2.
 *
 * Invariants (also enforced by unit tests):
 *   - 6 entries total
 *   - 21 criteria total (3 / 3 / 3 / 5 / 4 / 3)
 *   - every entry carries the same `rulesetVersion`
 *   - every criterion id is unique across the registry
 *
 * Advisory-only per CLAUDE.md §17.2 — no workflow gating.
 */
export const NAKHON_RATCHASIMA_RULESET_VERSION = '2026-04-18';

export const NAKHON_RATCHASIMA_ISSUE_RULES: IssueRuleEntry[] = [
  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 1 — ด้านโครงการตามแนวทางพระราชดำริ
  // Architecture §2.1 — 3 criteria, all advisory/preferred
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'royal-initiated',
    issueDisplayName: 'ด้านโครงการตามแนวทางพระราชดำริ',
    characteristics: [
      'โครงการตามแนวทางพระราชดำริเพื่อปรับปรุง / พัฒนาแหล่งน้ำ',
      'โครงการตามแนวปรัชญาเศรษฐกิจพอเพียง',
    ],
    matchers: {
      exactNames: [
        'ด้านโครงการตามแนวทางพระราชดำริ',
        'ประเด็นการพัฒนาด้านโครงการตามแนวทางพระราชดำริ',
      ],
      keywordContains: ['พระราชดำริ', 'เศรษฐกิจพอเพียง'],
    },
    subTypes: [
      { code: '1.1', label: 'ปรับปรุง / พัฒนาแหล่งน้ำตามแนวทางพระราชดำริ' },
      { code: '1.2', label: 'โครงการตามแนวปรัชญาเศรษฐกิจพอเพียง' },
    ],
    criteria: [
      {
        id: 'C1.a',
        label: 'ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        description: 'เป็นโครงการที่ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 1'],
      },
      {
        id: 'C1.b',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 1'],
      },
      {
        id: 'C1.c',
        label: 'ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น',
        description:
          'เป็นโครงการที่ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น ในพื้นที่เดียวกัน',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 1'],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
    ],
  },

  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 2 — ด้านการพัฒนาคุณภาพชีวิต
  // Architecture §2.2 — 3 criteria (standard set), 5 sub-types
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'quality-of-life',
    issueDisplayName: 'ด้านการพัฒนาคุณภาพชีวิต',
    characteristics: [
      'โครงการด้านการศึกษา กีฬา นันทนาการ สาธารณสุข',
      'โครงการพัฒนาคุณภาพชีวิตผู้สูงอายุ ผู้พิการ ผู้ยากไร้ เด็ก สตรี',
      'โครงการรณรงค์และแก้ไขปัญหายาเสพติด',
    ],
    matchers: {
      exactNames: [
        'ด้านการพัฒนาคุณภาพชีวิต',
        'ประเด็นการพัฒนาด้านการพัฒนาคุณภาพชีวิต',
      ],
      keywordContains: ['คุณภาพชีวิต', 'สาธารณสุข', 'การศึกษา'],
    },
    subTypes: [
      { code: '2.1', label: 'การศึกษา' },
      { code: '2.2', label: 'ส่งเสริมกีฬา / กิจกรรมนันทนาการ' },
      { code: '2.3', label: 'งานสาธารณสุข / ป้องกันควบคุมโรค' },
      {
        code: '2.4',
        label:
          'พัฒนาคุณภาพชีวิต (ผู้สูงอายุ / ผู้พิการ / ผู้ยากไร้ / เด็ก / สตรี)',
      },
      { code: '2.5', label: 'รณรงค์ / แก้ไขปัญหายาเสพติด' },
    ],
    criteria: [
      {
        id: 'C2.a',
        label: 'ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        description: 'เป็นโครงการที่ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 2'],
      },
      {
        id: 'C2.b',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 2'],
      },
      {
        id: 'C2.c',
        label: 'ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น',
        description:
          'เป็นโครงการที่ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น ในพื้นที่เดียวกัน',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 2'],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
    ],
  },

  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 3.1 — ด้านพัฒนาเศรษฐกิจ (เพิ่มขีดความสามารถ / SOFT POWER)
  // Architecture §2.3 — 3 criteria (standard set), 5 sub-types
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'economic-3-1',
    issueDisplayName:
      'ด้านพัฒนาเศรษฐกิจ — เพิ่มขีดความสามารถทางเศรษฐกิจ / เกษตร / อุตสาหกรรม / ท่องเที่ยว / ยกระดับมาตรฐาน / SOFT POWER',
    characteristics: [
      'โครงการเพิ่มขีดความสามารถทางเศรษฐกิจของ อปท.',
      'โครงการด้านเกษตร อุตสาหกรรม SMEs ท่องเที่ยว',
      'โครงการยกระดับมาตรฐานผลิตภัณฑ์',
      'โครงการส่งเสริม SOFT POWER',
    ],
    matchers: {
      exactNames: [
        'ด้านพัฒนาเศรษฐกิจ',
        'ประเด็นการพัฒนาด้านพัฒนาเศรษฐกิจ',
      ],
      keywordContains: [
        'เศรษฐกิจ',
        'เกษตร',
        'อุตสาหกรรม',
        'ท่องเที่ยว',
        'SOFT POWER',
        'ผลิตภัณฑ์',
      ],
    },
    subTypes: [
      { code: '3.1.1', label: 'เกษตร' },
      { code: '3.1.2', label: 'อุตสาหกรรม / SMEs' },
      { code: '3.1.3', label: 'ท่องเที่ยว' },
      { code: '3.1.4', label: 'ยกระดับมาตรฐานผลิตภัณฑ์' },
      { code: '3.1.5', label: 'SOFT POWER' },
    ],
    criteria: [
      {
        id: 'C3_1.a',
        label: 'ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        description: 'เป็นโครงการที่ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.1'],
      },
      {
        id: 'C3_1.b',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชนโดยตรง',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.1'],
      },
      {
        id: 'C3_1.c',
        label: 'ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น',
        description:
          'เป็นโครงการที่ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น ในพื้นที่เดียวกัน',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.1'],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
    ],
  },

  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 3.2 — แหล่งน้ำเพื่อการเกษตร (คาบเกี่ยว 2+ อปท.)
  // Architecture §2.3 — 5 criteria; 2 blocking (C3_2.c / C3_2.d)
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'economic-3-2',
    issueDisplayName: 'ด้านพัฒนาเศรษฐกิจ — แหล่งน้ำเพื่อการเกษตร (คาบเกี่ยว 2+ อปท.)',
    characteristics: [
      'โครงการปรับปรุง / ขุดลอก / พัฒนาแหล่งน้ำเพื่อการเกษตร',
      'แหล่งน้ำธรรมชาติที่คาบเกี่ยว 2 อปท. ขึ้นไป หรือเกิดประโยชน์มากกว่า 1 อปท.',
    ],
    matchers: {
      exactNames: [
        'ด้านพัฒนาเศรษฐกิจ — แหล่งน้ำเพื่อการเกษตร',
        'แหล่งน้ำเพื่อการเกษตร',
      ],
      keywordContains: [
        'แหล่งน้ำ',
        'ขุดลอก',
        'พัฒนาแหล่งน้ำ',
        'น้ำเพื่อการเกษตร',
      ],
    },
    subTypes: [
      {
        code: '3.2.1',
        label: 'ปรับปรุง / ขุดลอก / พัฒนาแหล่งน้ำเพื่อการเกษตร',
      },
    ],
    criteria: [
      {
        id: 'C3_2.a',
        label: 'แหล่งน้ำธรรมชาติคาบเกี่ยว 2+ อปท.',
        description:
          'เป็นแหล่งน้ำธรรมชาติที่คาบเกี่ยวพื้นที่ 2 อปท. ขึ้นไป หรือเป็นแหล่งน้ำที่เกิดประโยชน์มากกว่า 1 อปท.',
        weight: 2,
        criticality: 'advisory',
        evidenceRequired: false,
        geoAutoCheck: 'cross-amphoe',
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.2'],
      },
      {
        id: 'C3_2.b',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.2'],
      },
      {
        id: 'C3_2.c',
        label: 'ไม่เป็นเขตป่าสงวน / อุทยาน / ลุ่มน้ำชั้น 1A-1B',
        description:
          'พื้นที่ดำเนินการต้องไม่เป็นเขตป่าสงวนแห่งชาติ เขตอุทยานแห่งชาติ หรือพื้นที่ลุ่มน้ำชั้น 1A และ 1B',
        weight: 3,
        criticality: 'blocking',
        evidenceRequired: true,
        evidenceTags: ['land-use-permit', 'forest-clearance'],
        geoAutoCheck: 'in-protected-zone',
        sourceRefs: [
          'หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.2',
          'พ.ร.บ. ป่าสงวนแห่งชาติ / พ.ร.บ. อุทยานแห่งชาติ',
        ],
      },
      {
        id: 'C3_2.d',
        label: 'มีหลักฐานการขออนุญาตใช้พื้นที่',
        description:
          'มีหลักฐานแสดงการได้รับอนุญาตให้ใช้พื้นที่ / หนังสืออนุญาตจากหน่วยงานเจ้าของพื้นที่',
        weight: 3,
        criticality: 'blocking',
        evidenceRequired: true,
        evidenceTags: ['land-use-permit'],
        geoAutoCheck: 'attachment-presence',
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 3.2'],
      },
      {
        id: 'C3_2.e',
        label: 'ปฏิบัติตามระเบียบ มท. ขุดลอก + พ.ร.บ. การเดินเรือ',
        description:
          'ดำเนินการตามระเบียบกระทรวงมหาดไทยว่าด้วยการขุดลอก พ.ศ. 2547 และ พ.ร.บ. การเดินเรือในน่านน้ำไทย',
        weight: 2,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: [
          'ระเบียบ มท. ว่าด้วยการขุดลอก พ.ศ. 2547',
          'พ.ร.บ. การเดินเรือในน่านน้ำไทย',
        ],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
      'ระเบียบ มท. ว่าด้วยการขุดลอก พ.ศ. 2547',
    ],
  },

  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 4.1-4.4 — ก่อสร้าง/ซ่อม/ถ่ายโอน ถนน สะพาน ไฟฟ้าแสงสว่าง
  // Architecture §2.4 — 4 criteria incl. road-standard clause
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'urban-4-1to4',
    issueDisplayName:
      'ด้านการพัฒนาเมือง — ก่อสร้าง / ซ่อมแซม / ถ่ายโอน ถนน / สะพาน / ไฟฟ้าแสงสว่าง',
    characteristics: [
      'โครงการก่อสร้าง / ซ่อมแซมถนน / สะพาน',
      'โครงการถ่ายโอนถนนจาก อปท. อื่น',
      'โครงการไฟฟ้าแสงสว่างสาธารณะ',
    ],
    matchers: {
      exactNames: [
        'ด้านการพัฒนาเมือง',
        'ประเด็นการพัฒนาด้านการพัฒนาเมือง',
      ],
      keywordContains: [
        'พัฒนาเมือง',
        'ถนน',
        'สะพาน',
        'ไฟฟ้าแสงสว่าง',
        'ถ่ายโอน',
      ],
    },
    subTypes: [
      { code: '4.1', label: 'ก่อสร้าง / ซ่อมแซมถนน' },
      { code: '4.2', label: 'ถนนถ่ายโอนจาก อปท. อื่น' },
      {
        code: '4.3',
        label: 'สะพาน (ความกว้างสะพาน ≥ ผิวจราจร + ทางเท้า)',
      },
      { code: '4.4', label: 'ไฟฟ้าแสงสว่างสาธารณะ' },
    ],
    criteria: [
      {
        id: 'C4_1to4.a',
        label: 'เชื่อมต่อระหว่าง 2+ อปท.',
        description:
          'เป็นโครงการที่เชื่อมต่อระหว่างพื้นที่ของ อปท. 2 แห่งขึ้นไป',
        weight: 2,
        criticality: 'advisory',
        evidenceRequired: false,
        geoAutoCheck: 'cross-amphoe',
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.1-4.4'],
      },
      {
        id: 'C4_1to4.b',
        label: 'เป็นไปตามมาตรฐานกรมทางหลวงชนบท 2550',
        description:
          'ก่อสร้างตามมาตรฐานกรมทางหลวงชนบท พ.ศ. 2550 (คอนกรีต / ค.ส.ล. ผิวจราจรกว้าง ≥ 5 เมตร)',
        weight: 2,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: [
          'หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.1-4.4',
          'มาตรฐานกรมทางหลวงชนบท พ.ศ. 2550',
        ],
      },
      {
        id: 'C4_1to4.c',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.1-4.4'],
      },
      {
        id: 'C4_1to4.d',
        label: 'อปท. ในพื้นที่ดำเนินการเองไม่ได้',
        description:
          'เป็นโครงการที่ อปท. ในพื้นที่ไม่สามารถดำเนินการเองได้ จึงต้องอาศัย อบจ. ดำเนินการ',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.1-4.4'],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
      'มาตรฐานกรมทางหลวงชนบท พ.ศ. 2550',
    ],
  },

  // -------------------------------------------------------------------
  // ประเด็นการพัฒนา 4.5-4.6 — ป้องกันสาธารณภัย + ฟื้นฟูทรัพยากรและสิ่งแวดล้อม
  // Architecture §2.4 — 3 criteria (no road-standard clause)
  // -------------------------------------------------------------------
  {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'urban-4-5to6',
    issueDisplayName:
      'ด้านการพัฒนาเมือง — ป้องกันและบรรเทาสาธารณภัย / ฟื้นฟูทรัพยากรและสิ่งแวดล้อม',
    characteristics: [
      'โครงการป้องกันและบรรเทาสาธารณภัย',
      'โครงการฟื้นฟูทรัพยากรธรรมชาติและสิ่งแวดล้อม',
    ],
    matchers: {
      exactNames: [
        'ด้านการพัฒนาเมือง — สาธารณภัย / สิ่งแวดล้อม',
      ],
      keywordContains: [
        'สาธารณภัย',
        'ป้องกันภัย',
        'ทรัพยากรธรรมชาติ',
        'สิ่งแวดล้อม',
        'ฟื้นฟู',
      ],
    },
    subTypes: [
      { code: '4.5', label: 'การป้องกันและบรรเทาสาธารณภัย' },
      { code: '4.6', label: 'ฟื้นฟูทรัพยากรธรรมชาติและสิ่งแวดล้อม' },
    ],
    criteria: [
      {
        id: 'C4_5to6.a',
        label: 'ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        description: 'เป็นโครงการที่ดำเนินการในภาพรวมของจังหวัด / อำเภอ',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.5-4.6'],
      },
      {
        id: 'C4_5to6.b',
        label: 'คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        description: 'เป็นโครงการที่คุ้มค่าและเกิดประโยชน์แก่ประชาชน',
        weight: 1,
        criticality: 'preferred',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.5-4.6'],
      },
      {
        id: 'C4_5to6.d',
        label: 'ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น',
        description:
          'เป็นโครงการที่ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น ในพื้นที่เดียวกัน',
        weight: 1,
        criticality: 'advisory',
        evidenceRequired: false,
        sourceRefs: ['หลักเกณฑ์ อบจ. นครราชสีมา — ประเด็น 4.5-4.6'],
      },
    ],
    rulesetVersion: NAKHON_RATCHASIMA_RULESET_VERSION,
    sourceRefs: [
      'อบจ. นครราชสีมา — หลักเกณฑ์การเสนอโครงการประสานแผนพัฒนาท้องถิ่นแบบบูรณาการ',
    ],
  },
];
