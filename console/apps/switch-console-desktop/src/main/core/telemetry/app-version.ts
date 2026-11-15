import type { TelemetryAppVersion } from './events';

/**
 * The shape of a version this app reports for itself: semver, with the
 * prerelease part a canary build carries (`0.41.0-canary.3`). Short, and with
 * nothing in it that could be a name or a path.
 */
const APP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,24})?$/;

/**
 * A version as a reportable value, or `unknown` when it does not look like one.
 *
 * The version an event already carries comes from the running build. One read
 * back from local storage, as the last launch's is, has only been written by this
 * app, but it is still checked rather than trusted: nothing may reach a payload as
 * free text.
 */
export function appVersionOf(raw: string): TelemetryAppVersion | 'unknown' {
  return APP_VERSION.test(raw) ? (raw as TelemetryAppVersion) : 'unknown';
}
