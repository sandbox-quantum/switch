import { appendFileSync } from 'node:fs';

/** The host handed a room message's command to its provider adapter. */
export const PROVIDER_DISPATCH = 'provider_dispatch';

/** The session's `post_message` through its own MCP server came back as posted. */
export const REPLY_POSTED = 'reply_posted';

/** The turn gave up on its reply; the detail says what it was told. */
export const REPLY_FAILED = 'reply_failed';

/** The provider opened an approval request and is waiting on it. */
export const APPROVAL_REQUESTED = 'approval_requested';

/** The host handed the provider a person's answer to its request. */
export const APPROVAL_APPLIED = 'approval_applied';

/** The session's `connect_to_room` came back; the detail carries its result. */
export const ROOM_CONNECTED = 'room_connected';

/** Names the file every process in one benchmark run appends its trace to. */
const TRACE_VARIABLE = 'SWITCH_BENCH_TRACE';

const origin = `bench-host:${process.pid}`;

/**
 * Append one trace record for the benchmark driver to score.
 *
 * Both clock readings are written because the span this feeds crosses a
 * process and a language boundary: `mono_ns` is exact within this process and
 * `wall_ns` is the only reading comparable with the server's, so the driver
 * can compute a span either way and report how far the two disagree.
 *
 * Synchronous and append-only on purpose. Every host process in a run writes
 * to one file, and a record shorter than the pipe buffer appended through
 * `O_APPEND` lands whole; buffering it instead would lose the tail of a run
 * whenever a worker is killed, which is one of the cases being measured.
 */
export function traceRecord(
  point: string,
  correlation: string,
  detail: Record<string, unknown>
): void {
  const path = process.env[TRACE_VARIABLE];
  if (!path)
    throw new Error(
      `${TRACE_VARIABLE} is unset. A benchmark host must be told where to write its trace.`
    );
  const elapsed = performance.now();
  appendFileSync(
    path,
    `${JSON.stringify({
      point,
      correlation,
      wall_ns: Math.round((performance.timeOrigin + elapsed) * 1e6),
      mono_ns: Number(process.hrtime.bigint()),
      process: origin,
      detail,
    })}\n`
  );
}
