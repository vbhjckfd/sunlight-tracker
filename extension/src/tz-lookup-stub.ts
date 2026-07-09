/**
 * Build-time replacement for `tz-lookup` (see the esbuild `--alias` in the
 * `build:extension` script). LUN.ua only lists Ukrainian real estate, so the
 * pin is always in the Europe/Kyiv zone — no need to ship the ~170 KB
 * coordinate-to-zone lookup table in the content script.
 */
export default function tzLookup(_lat: number, _lng: number): string {
  return "Europe/Kyiv";
}
