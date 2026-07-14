/**
 * MUNICIPAL_PROFILE — single source of truth for the home organization's
 * identity + geography used across the AI prompt pipeline.
 *
 * planChatt is a SINGLE-อปท system: เทศบาลตำบลหนองกระทุ่ม (LAO row 3001027,
 * amphoe 3001, tambon 300124). Before this module the AI persona was a generic
 * "ผู้เชี่ยวชาญวางแผนท้องถิ่น" with no organizational identity, so the LLM
 * defaulted to speaking as อบจ. (provincial). This profile is injected into
 * every prompt so the model KNOWS it works for this municipality.
 *
 * ORG axis (laoId/amphoeCode) = the LAO-table key that every gate/FK uses.
 * GEO axis (tambonCode 300124) = the national subdistrict code used only by
 * boundary GeoJSON / maps. They are intentionally distinct; do not conflate.
 *
 * `laoName` honors the ORG_LAO_NAME override (same env the OrgSeedService uses)
 * so a deliberate rename propagates to the AI voice too. Everything else is a
 * stable constant for this deployment.
 */
export const MUNICIPAL_PROFILE = {
  laoId: '3001027',
  laoName: process.env.ORG_LAO_NAME?.trim() || 'เทศบาลตำบลหนองกระทุ่ม',
  laoType: 'เทศบาลตำบล',
  tambonCode: '300124',
  tambonName: 'หนองกระทุ่ม',
  amphoeCode: '3001',
  amphoeName: 'เมืองนครราชสีมา',
  changwatCode: '30',
  changwatName: 'นครราชสีมา',
  /**
   * Factual area dossier (population, villages, area sq.km, key issues).
   * EMPTY until the owner supplies verified numbers — the persona's
   * no-fabrication rule forbids the model from inventing statistics, so an
   * empty dossier yields descriptive (non-numeric) grounding, never made-up
   * figures.
   */
  dossier: [] as string[],
} as const;

/** Full "ตำบลหนองกระทุ่ม อำเภอเมืองนครราชสีมา จังหวัดนครราชสีมา" locality string. */
export function municipalAreaLabel(): string {
  const p = MUNICIPAL_PROFILE;
  return `ตำบล${p.tambonName} อำเภอ${p.amphoeName} จังหวัด${p.changwatName}`;
}

/**
 * The `[MUNICIPAL_CONTEXT]` block injected into generator/reviewer prompts so
 * the model grounds every draft in this municipality. Input-side only — it
 * does not demand extra output length. Includes the factual dossier when
 * available; otherwise notes that no area statistics are on file.
 */
export function buildMunicipalContextBlock(): string {
  const p = MUNICIPAL_PROFILE;
  const lines = [
    '[MUNICIPAL_CONTEXT]',
    `หน่วยงาน: ${p.laoName} (${p.laoType})`,
    `พื้นที่รับผิดชอบ: ${municipalAreaLabel()}`,
  ];
  if (p.dossier.length > 0) {
    lines.push('ข้อมูลพื้นที่ (ใช้อ้างอิงได้เท่านั้น ห้ามสร้างตัวเลขใหม่):');
    for (const d of p.dossier) lines.push(`- ${d}`);
  } else {
    lines.push(
      'ข้อมูลสถิติพื้นที่: ยังไม่มีข้อมูลตัวเลขในระบบ — ให้เขียนเชิงพรรณนาโดยไม่ระบุตัวเลขที่ไม่ได้ให้ไว้',
    );
  }
  return lines.join('\n');
}
