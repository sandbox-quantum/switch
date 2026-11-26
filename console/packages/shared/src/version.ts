/**
 * Compare two dotted version strings numerically, segment by segment. Returns a
 * negative number when `a < b`, positive when `a > b`, and 0 when equal. Missing
 * trailing segments count as 0 (so '18' === '18.0.0'). Non-numeric input yields 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10));
  const pb = b.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}
