import type { TelemetryDurationMs } from './events';

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
