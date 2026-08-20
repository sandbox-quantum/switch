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
 * There is no telemetry in the app today — this is the gate the collection work
 * (CHOO-1683) is expected to call once there is something to send. What it may
 * send is constrained: see the payload rule in `console/AGENTS.md`. Anonymous
 * counters only, and no identifier of any kind, because the toggle defaults to
 * on and an opt-out default is only defensible for non-personal data.
 */
export async function isTelemetryAllowed(): Promise<boolean> {
  const telemetry = await appSettingsService.get('telemetry');
  return telemetry.askedAt !== null && telemetry.enabled;
}
