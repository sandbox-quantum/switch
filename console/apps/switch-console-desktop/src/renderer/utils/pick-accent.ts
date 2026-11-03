/**
 * The most common vivid colour in RGBA pixels, averaged within its bucket;
 * null when there is none. Transparent, grey, near-white and near-black pixels
 * are skipped, so an avatar's background and outlines never win.
 */
export function pickAccent(pixels: Uint8ClampedArray): [number, number, number] | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const r = pixels[at]!;
    const g = pixels[at + 1]!;
    const b = pixels[at + 2]!;
    if (pixels[at + 3]! < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 40 || min > 225 || (max - min) / max < 0.25) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) if (!best || bucket.count > best.count) best = bucket;
  if (!best) return null;
  return [best.r, best.g, best.b].map((sum) => Math.round(sum / best.count)) as [
    number,
    number,
    number,
  ];
}
