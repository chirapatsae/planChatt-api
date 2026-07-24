/**
 * Presentation helpers for the device-manager listings (Batch 2).
 *
 * Pure, dependency-free formatters shared by BOTH the citizen and staff session
 * registries so the two device-manager rows read identically. Living in the
 * neutral `common/session-registry` folder (next to `session-device.util`) keeps
 * either cohort from importing the other's service (§17.3 boundary spirit).
 */

/** `Chrome · iOS` (coarse), tolerating null / Unknown labels. */
export function sessionDeviceLabel(
  browser: string | null,
  os: string | null,
): string {
  const parts = [browser, os].filter(
    (x): x is string => !!x && x !== 'Unknown',
  );
  return parts.length ? parts.join(' · ') : 'อุปกรณ์ไม่ทราบชนิด';
}

/**
 * `city, country` → else the country alone → else the city alone → else the
 * masked /24 subnet → else null. The `LAN` geo sentinel (private / on-prem) is
 * surfaced as a Thai label instead of the raw code so the row is readable.
 */
export function sessionLocationLabel(
  city: string | null,
  country: string | null,
  subnet24: string | null,
): string | null {
  if (country === 'LAN') return 'เครือข่ายภายใน';
  if (city && country) return `${city}, ${country}`;
  if (country) return country;
  if (city) return city;
  if (subnet24) return subnet24;
  return null;
}
