import { hashSecret } from 'src/util/encryption.util';

/**
 * Device / user-agent helpers for the session registry (Batch 1).
 *
 * Deliberately dependency-free (no `ua-parser-js` etc.) — a ~30-line hand-rolled
 * parser is enough for the coarse `browser` / `os` labels we surface in the
 * device-manager UI and fold into the new-device match key. We only need
 * stable, human-readable buckets, NOT forensic precision.
 */

export interface ParsedUserAgent {
  /** Coarse browser label, e.g. `Chrome`, `Safari`, `Firefox`, `Edge`. */
  browser: string;
  /** Coarse OS label, e.g. `Windows`, `macOS`, `iOS`, `Android`, `Linux`. */
  os: string;
}

/**
 * Hand-rolled UA sniff. Order matters: more specific tokens are tested before
 * the generic ones they embed (Edge/OPR before Chrome; Chrome before Safari,
 * since Chrome's UA also contains `Safari`).
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  const s = (ua || '').toString();

  // --- Browser ---------------------------------------------------------
  let browser = 'Unknown';
  if (/Edg(e|A|iOS)?\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/CriOS\//i.test(s)) browser = 'Chrome';
  else if (/Chrome\/|Chromium/i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';

  // --- OS --------------------------------------------------------------
  let os = 'Unknown';
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod|iOS/i.test(s)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Linux/i.test(s)) os = 'Linux';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';

  return {
    browser: browser.slice(0, 48),
    os: os.slice(0, 48),
  };
}

/**
 * New-device / session match key. HMAC-SHA256 hex (via `hashSecret`) of
 * `browser|os|subnet24` — coarse enough that a phone hopping between cell
 * towers inside the same /24 keeps a stable hash, distinct enough that a new
 * browser or a different subnet is treated as a new device. Batch 2's alert
 * logic compares this against the account's prior sessions.
 */
export function deviceHash(
  browser: string,
  os: string,
  subnet24: string | null | undefined,
): string {
  return hashSecret(`${browser}|${os}|${subnet24 ?? ''}`);
}
