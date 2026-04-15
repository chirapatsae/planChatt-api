import * as fs from 'fs';
import * as path from 'path';

/**
 * Thai keyword-based project type classifier.
 *
 * Soft heuristic per CLAUDE.md §13 (LAO geo rule) — provides a best-effort
 * category signal for mismatch advisory. Output is never used to block
 * workflow transitions.
 */

export interface ClassifiedProjectType {
  code: string;
  label: string;
  confidence: number;
  expectedAreaTypes: string[];
  suspiciousAreaTypes: string[];
}

interface KeywordEntry {
  label: string;
  keywords: string[];
  expectedAreaTypes: string[];
  suspiciousAreaTypes: string[];
}

type KeywordDictionary = Record<string, KeywordEntry>;

let cachedDictionary: KeywordDictionary | null = null;

function loadDictionary(): KeywordDictionary {
  if (cachedDictionary) return cachedDictionary;
  try {
    const filePath = path.resolve(__dirname, '..', 'data', 'project-type-keywords.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    cachedDictionary = JSON.parse(raw) as KeywordDictionary;
  } catch {
    cachedDictionary = {};
  }
  return cachedDictionary;
}

/**
 * Classify a Thai text (project title + objective) into a single project-type
 * category using simple keyword occurrence counting.
 *
 * - Counts occurrences of each keyword in the text (case-insensitive).
 * - Chooses the category with the highest total score.
 * - Confidence = matchedScore / (matchedScore + 3), bounded in [0, 1).
 * - Returns null when no keyword matched any category.
 */
export function classifyProjectType(text: string): ClassifiedProjectType | null {
  if (!text || typeof text !== 'string') return null;

  const dictionary = loadDictionary();
  const lowerText = text.toLowerCase();

  let bestCode: string | null = null;
  let bestScore = 0;
  let bestEntry: KeywordEntry | null = null;

  for (const [code, entry] of Object.entries(dictionary)) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (!keyword) continue;
      const needle = keyword.toLowerCase();
      // Count non-overlapping occurrences.
      let idx = 0;
      while ((idx = lowerText.indexOf(needle, idx)) !== -1) {
        score += 1;
        idx += needle.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCode = code;
      bestEntry = entry;
    }
  }

  if (!bestCode || !bestEntry || bestScore === 0) {
    return null;
  }

  // Simple confidence — saturates towards 1 as matches accumulate.
  const confidence = Math.min(0.99, bestScore / (bestScore + 3));

  return {
    code: bestCode,
    label: bestEntry.label,
    confidence,
    expectedAreaTypes: bestEntry.expectedAreaTypes || [],
    suspiciousAreaTypes: bestEntry.suspiciousAreaTypes || [],
  };
}
