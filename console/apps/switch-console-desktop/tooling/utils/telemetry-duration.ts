import type { TelemetryDurationMs } from '@main/core/telemetry/events';

/**
 * Duration helpers for tests.
 *
 * Under `tooling/` rather than beside the emitter, because the brand on
 * `TelemetryDurationMs` is only worth having if nothing else can apply it:
 * `durationMs` below is exactly the cast `startTimer()` exists to be the one
 * holder of. Here, `switch-console/no-tooling-imports` makes importing it from
 * the main or preload process a lint error, and `@tooling` is not aliased in
 * `electron.vite.config.ts` at all — so a call site reaching for it fails twice
 * over, rather than compiling and minting a duration no clock produced.
 */

/**
 * A duration for a test that needs a specific number.
 *
 * `startTimer()` is the only thing that mints a `TelemetryDurationMs` in
 * production, which is the point of the brand. A test asserting on an exact
 * value cannot go through a real clock, so it says so here rather than
 * scattering casts through the suites.
 */
export function durationMs(value: number): TelemetryDurationMs {
  return value as TelemetryDurationMs;
}

/**
 * Matches a duration a real timer could have produced.
 *
 * `expect.any(Number)` is satisfied by `NaN` and `Infinity`, both of which the
 * emitter refuses at send time (`allowedProperties` throws on a non-finite
 * value) — so an assertion written with it passes against a payload that would
 * never reach the far end, which is the opposite of what the assertion is for.
 * This holds the value to what `startTimer()` guarantees: a whole number of
 * milliseconds that cannot be negative.
 */
export const aDurationMs = {
  asymmetricMatch: (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
  toString: (): string => 'aDurationMs',
  getExpectedType: (): string => 'number',
};
