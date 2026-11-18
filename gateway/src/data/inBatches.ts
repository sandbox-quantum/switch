// The most rooms one bulk request may name; the server refuses more
// (`BULK_ROOMS_MAX` in core's gateway schemas).
export const BULK_ROOMS_MAX = 200;

// How many requests one action keeps in flight when it makes one per item:
// each holds a database connection on the server while it runs.
export const REQUESTS_AT_ONCE = 4;

/** `items` in runs of at most `size`, in order. */
export function inChunks<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** `Promise.allSettled(items.map(run))`, with at most `atOnce` running. */
export async function settleAtMost<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  atOnce: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return results;
}

/** `Promise.all(items.map(run))`, with at most `atOnce` running: every item
 * is tried, then the first failure is thrown. */
export async function allAtMost<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  atOnce: number,
): Promise<R[]> {
  const results = await settleAtMost(items, run, atOnce);
  const values: R[] = [];
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values;
}
