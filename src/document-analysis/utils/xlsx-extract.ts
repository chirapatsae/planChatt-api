/**
 * xlsx-extract.ts
 *
 * Lightweight XLSX text extraction via the `xlsx` library.
 *
 * Contract (docs/tasks/DOCUMENT_ANALYSIS_PHASE3_EXPANSION.md §3.1):
 *   - Multi-sheet workbooks supported: iterate every sheet, concat CSVs.
 *   - Formulas are NOT evaluated; raw cached cell values only (default
 *     xlsx behavior when `sheet_to_csv` is called without explicit
 *     formula-evaluation flags). This prevents formula-injection vectors.
 *   - Returns a single string that the caller truncates to MAX_EXTRACTED_CHARS.
 *
 * Kept intentionally small — no streaming, no sheet name filtering. For
 * government-scale spreadsheets (a few thousand rows max), the default
 * `read` / `sheet_to_csv` API is fast enough.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

export async function extractXlsxText(filePath: string): Promise<string> {
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(filePath, { cellFormula: false });
  const sheetNames: string[] = wb.SheetNames ?? [];
  const parts: string[] = [];
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv && csv.trim()) {
      parts.push(`# Sheet: ${name}\n${csv}`);
    }
  }
  return parts.join('\n\n').trim();
}
