import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import type {
  TelemetryActivationMilestone,
  TelemetryActivationPath,
  TelemetryEvent,
  TelemetryEventMap,
} from './events';
import { launchInstallKind } from './launch-history';
import { telemetryService, trackEvent } from './telemetry-service';

/**
 * The steps from installing the app to an agent doing work, as
 * `activation_milestone`, each reported once for the life of an install, the
 * first time it is reached:
 *
 * - `server_ready`: signed in to a server, or a server the app runs started.
 * - `agent_ready`: an agent created, however it was made.
 * - `first_agent_session`: a session of one of its agents started, in the app
 *   (`session_started`) or on the agent controller it runs on this computer
 *   (`managed_session_started`).
 *
 * Each is derived from the event that marks it, once that event has been sent,
 * rather than reported at each place it can happen: a new way to sign in or
 * make an agent counts towards activation by reporting its own event, with
 * nothing more to wire. Following a sent event also keeps the claim behind the
 * consent gate, and a milestone whose event did not get through is reached
 * again the next time it happens.
 *
 * Only an install that began on a version reporting milestones reports them.
 * One that already existed passed some of them before anything recorded it,
 * and taking its next sign-in or session for its first would count every
 * existing install as newly activated.
 */

type ActivationRecords = {
  /** Whether this install reports milestones; decided once, on its first launch with them. */
  tracked: boolean;
  path: Exclude<TelemetryActivationPath, 'unknown'>;
} & Record<TelemetryActivationMilestone, boolean>;

const store = new KV<ActivationRecords>('telemetry-activation');

/** The milestone an event marks, if any. */
export function milestoneOf(event: TelemetryEvent): TelemetryActivationMilestone | null {
  switch (event.name) {
    case 'server_sign_in':
      return event.properties.outcome === 'success' ? 'server_ready' : null;
    case 'managed_server_action':
      return event.properties.action === 'start' && event.properties.outcome === 'success'
        ? 'server_ready'
        : null;
    case 'agent_created':
      return event.properties.outcome === 'success' ? 'agent_ready' : null;
    case 'session_started':
      return event.properties.outcome === 'success' ? 'first_agent_session' : null;
    case 'managed_session_started':
      return 'first_agent_session';
    default:
      return null;
  }
}

let tracking: Promise<boolean> | null = null;

/**
 * Whether this install reports milestones, deciding it on the first launch
 * that asks. Boot asks as soon as the launch is recorded, so a new install that
 * quits before reaching any milestone is still decided on its first launch.
 * A launch that could not be recorded decides nothing, and the next one does.
 */
export function activationTracked(): Promise<boolean> {
  tracking ??= (async () => {
    const decided = await store.get('tracked');
    if (decided !== null) return decided;
    const kind = await launchInstallKind();
    if (kind === 'unknown') return false;
    const tracked = kind === 'new';
    await store.setOrThrow('tracked', tracked);
    return tracked;
  })();
  return tracking;
}

/**
 * The way the install went at Meet switch-buddy, kept in memory as well as
 * stored: starting the buddy and creating it are reported moments apart, and
 * the create's `agent_ready` must not read the record before it is written.
 */
let routeThisRun: ActivationRecords['path'] | null = null;

/**
 * Note which way the install went at Meet switch-buddy, from a `buddy_step`
 * the interface reported. The first answer stands: someone who skipped the
 * buddy and set it up later went the manual way.
 */
export function noteBuddyStep(action: TelemetryEventMap['buddy_step']['action']): void {
  const route = action === 'start' ? 'buddy' : action === 'skip' ? 'manual' : null;
  if (route === null || routeThisRun !== null) return;
  routeThisRun = route;
  void (async () => {
    const stored = await store.get('path');
    if (stored !== null) {
      routeThisRun = stored;
      return;
    }
    await store.setOrThrow('path', route);
  })().catch((error: unknown) => {
    log.warn('telemetry: could not record the way through onboarding', { error });
  });
}

async function pathNow(): Promise<TelemetryActivationPath> {
  return (await store.get('path')) ?? routeThisRun ?? 'unknown';
}

const claimedThisRun = new Set<TelemetryActivationMilestone>();

/**
 * Whether this is the install's first time reaching the milestone, claiming it
 * if so. The in-memory guard comes first: the events that mark a milestone
 * arrive in bursts (several sessions restoring at once), and the stored record
 * does not land in time to stop the second. The write is `setOrThrow`, for the
 * reason `claimOnce` in `./renderer-events` gives: a record that did not save
 * is a report that may be missed, rather than one that is certainly repeated.
 */
async function claim(milestone: TelemetryActivationMilestone): Promise<boolean> {
  if (claimedThisRun.has(milestone)) return false;
  claimedThisRun.add(milestone);
  if (!(await activationTracked())) return false;
  if ((await store.get(milestone)) === true) return false;
  await store.setOrThrow(milestone, true);
  return true;
}

/** Report the milestone this sent event marks, if it is the install's first. */
export function noteSentEvent(event: TelemetryEvent): void {
  const milestone = milestoneOf(event);
  if (milestone === null) return;
  void (async () => {
    if (!(await claim(milestone))) return;
    trackEvent('activation_milestone', { milestone, path: await pathNow() });
  })().catch((error: unknown) => {
    log.warn('telemetry: could not record an activation milestone, so it is not sent', {
      milestone,
      error,
    });
  });
}

/**
 * Derive milestones from every event sent from now on, and decide whether this
 * install reports them. Boot calls it after starting the launch's recording,
 * which the decision waits on.
 */
export function startActivationTracking(): void {
  telemetryService.setSentListener(noteSentEvent);
  void activationTracked().catch((error: unknown) => {
    log.warn('telemetry: could not decide whether this install reports activation milestones', {
      error,
    });
  });
}
