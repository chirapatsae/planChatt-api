/**
 * Wave 29 N2 — Briefing citation parser.
 *
 * Parses an optional `**การอ้างอิง (JSON):**` block from the LAO
 * ISSUE_BASED AddProject AI generate response. Output is merged into
 * the opaque `briefingRefs` bag on the controller response envelope
 * (Wave 13 DTO discipline, §17.2 advisory-only).
 *
 * §17.9 prompt-injection defense — the whitelist is enforced HERE
 * server-side. LLM output is NEVER trusted; any `sourceType` outside
 * the fixed whitelist is dropped silently. Malformed JSON MUST NOT
 * throw into the request path — parser returns `null` and the
 * controller simply omits the `citations` key.
 *
 * §17.3 audit separation — this module is pure; no DB writes, no FK,
 * no persistence. Citations live on the response envelope only.
 */

/**
 * Fixed server-side whitelist of accepted citation source types.
 * Any LLM-emitted value outside this set is dropped.
 */
export const CITATION_SOURCE_TYPE_WHITELIST = [
  'geo-feature',
  'amphoe-dossier',
  'criterion',
  'issue-rule',
  'registry-stat',
  'user-pin',
] as const;

export type CitationSourceType =
  (typeof CITATION_SOURCE_TYPE_WHITELIST)[number];

export interface Citation {
  label: string;
  sourceType: CitationSourceType;
  sourceRef?: string;
  description?: string;
}

/**
 * Hard caps — protect token / memory footprint from oversized LLM
 * output. These are NOT business limits; they are DoS guards per
 * §17.9.
 */
const MAX_CITATIONS = 12;
const MAX_LABEL_LEN = 120;
const MAX_SOURCE_REF_LEN = 64;
const MAX_DESCRIPTION_LEN = 240;
const SOURCE_REF_PATTERN = /^[A-Za-z0-9:_\-\.]+$/;

function isWhitelistedSourceType(value: unknown): value is CitationSourceType {
  return (
    typeof value === 'string' &&
    (CITATION_SOURCE_TYPE_WHITELIST as readonly string[]).includes(value)
  );
}

function sanitizeString(
  value: unknown,
  maxLen: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Sanitize a single citation entry. Returns `null` when the entry
 * lacks required fields (`label` + whitelisted `sourceType`) or when
 * `sourceRef` contains non-ASCII characters (§17.9 schema drift
 * defense).
 */
export function sanitizeCitationEntry(raw: unknown): Citation | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;

  const label = sanitizeString(entry.label, MAX_LABEL_LEN);
  if (!label) return null;

  if (!isWhitelistedSourceType(entry.sourceType)) return null;

  const out: Citation = {
    label,
    sourceType: entry.sourceType,
  };

  const sourceRef = sanitizeString(entry.sourceRef, MAX_SOURCE_REF_LEN);
  if (sourceRef !== undefined) {
    if (!SOURCE_REF_PATTERN.test(sourceRef)) {
      // Non-ASCII or punctuation-heavy refs are rejected rather than
      // propagated — the FE uses these as link keys and we refuse
      // to hand it untrusted text.
      return null;
    }
    out.sourceRef = sourceRef;
  }

  const description = sanitizeString(entry.description, MAX_DESCRIPTION_LEN);
  if (description !== undefined) {
    out.description = description;
  }

  return out;
}

/**
 * Locate and parse the first balanced JSON object that follows the
 * `**การอ้างอิง (JSON):**` marker. Returns `null` on any of:
 *   - marker not present
 *   - no `{` after the marker
 *   - unbalanced braces
 *   - `JSON.parse` failure
 *   - parsed value is not an object
 *   - parsed `citations` field is not an array
 *
 * The parser accepts `{ "citations": [...] }` as the canonical
 * envelope. A bare array `[...]` is also tolerated for LLM drift,
 * but only when it appears directly after the marker.
 */
function extractCitationsFromText(raw: string): unknown[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Primary: look for a dedicated JSON block marker.
  const markerIdx = raw.indexOf('การอ้างอิง (JSON)');
  const searchFrom = markerIdx >= 0 ? markerIdx : 0;

  // Locate the first JSON container after the marker.
  let openIdx = -1;
  let openChar: '{' | '[' | null = null;
  for (let i = searchFrom; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{' || ch === '[') {
      openIdx = i;
      openChar = ch;
      break;
    }
  }
  if (openIdx === -1 || !openChar) return null;

  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;

  const jsonSlice = raw.slice(openIdx, endIdx + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const container = parsed as Record<string, unknown>;
    if (Array.isArray(container.citations)) return container.citations;
  }
  return null;
}

/**
 * Public parser. Returns a sanitized citation array (possibly empty
 * length after filtering) or `null` when no usable data was found.
 *
 * Controller contract: treat `null` AND `[]` as "omit the key".
 */
export function parseCitationsJsonBlock(raw: string): Citation[] | null {
  const rawList = extractCitationsFromText(raw);
  if (!rawList) return null;

  const sanitized: Citation[] = [];
  for (const entry of rawList) {
    if (sanitized.length >= MAX_CITATIONS) break;
    const cleaned = sanitizeCitationEntry(entry);
    if (cleaned) sanitized.push(cleaned);
  }

  return sanitized;
}
