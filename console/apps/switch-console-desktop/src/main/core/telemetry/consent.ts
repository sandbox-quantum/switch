import { appSettingsService } from '@main/core/settings/settings-service';

/**
 * Whether anonymous usage data may leave this machine right now.
 *
 * Nothing may be sent without calling this first and getting `true` back. It is
 * the only supported way to read the consent setting at an emission point, and
 * it is read before every send rather than cached, so turning the toggle off
 * stops the next event rather than the next launch.
 *
 * The toggle defaults to on, and `askedAt` deliberately plays no part here: an
 * opt-out default means sharing does not wait for the first-run notice to be
 * acknowledged. `askedAt` records only whether that notice still needs showing.
 *
 * It still fails closed on a settings read that throws. What may be sent is
 * constrained regardless of consent — see the payload rule in
 * `console/AGENTS.md` and the closed event catalogue in `./events`.
 */
export async function isTelemetryAllowed(): Promise<boolean> {
  const telemetry = await appSettingsService.get('telemetry');
  return telemetry.enabled;
}
