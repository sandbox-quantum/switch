import { appSettingsService } from '@main/core/settings/settings-service';

/**
 * Whether anonymous usage data may leave this machine right now.
 *
 * Nothing may be sent without calling this first and getting `true` back. It is
 * the only supported way to read the consent setting at an emission point: read
 * `telemetry.enabled` directly and you miss the "hasn't been asked yet" case,
 * which is not the same as "said yes".
 *
 * It fails closed on purpose. Consent requires both that the user has seen the
 * first-run prompt (`askedAt`) and that the toggle is on, so a fresh install
 * that has not reached the prompt sends nothing, and a settings read that
 * throws sends nothing either.
 *
 * The toggle defaults to off: what is sent carries a random per-install id, and
 * that makes the data pseudonymous rather than anonymous, which an opt-out
 * default would not cover. What may be sent is constrained beyond that — see
 * the payload rule in `console/AGENTS.md` and the closed event catalogue in
 * `./events`.
 */
export async function isTelemetryAllowed(): Promise<boolean> {
  const telemetry = await appSettingsService.get('telemetry');
  return telemetry.askedAt !== null && telemetry.enabled;
}
