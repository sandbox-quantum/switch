/**
 * How long the random identifier on usage data lives before it is replaced.
 *
 * Here rather than in the telemetry module because it is a promise as well as a
 * setting: the main process enforces it (`src/main/core/telemetry/install-id.ts`)
 * and the consent copy states it, so the two read the same number.
 * `docs/TELEMETRY.md` §5 states it too, and changes with it.
 */
export const TELEMETRY_ID_LIFETIME_DAYS = 30;
