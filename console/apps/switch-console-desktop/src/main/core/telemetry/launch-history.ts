import semver from 'semver';
import { resolveAppVersion } from '@main/core/app/utils';
import { pendingInstall } from '@main/core/updates/pending-install';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { IS_CANARY } from '@shared/app-identity';
import { appVersionOf } from './app-version';
import type { TelemetryEventMap, TelemetryInstallKind } from './events';
import { trackEvent } from './telemetry-service';

/**
 * Which kind of launch this is, from what the last launch on this channel
 * recorded.
 *
 * `new` is the first launch an installation ever makes, so counting it counts
 * new installs; `updated` is the first launch on a newer version than the last
 * one, an upgrade; `same` is everything else. An installation with a database
 * but no record on either channel predates this tracking, and its first launch
 * with it is on a version it was not installed at, so it reads as `updated`.
 *
 * Two launches are not upgrades although the version differs. The first on a
 * channel the installation has not run before, when the other one has a record,
 * is a switch between canary and stable. A launch on an older version than the
 * last is a downgrade, a person reinstalling an earlier build.
 */
export function installKindFor({
  lastVersion,
  version,
  databaseExisted,
  otherChannelLaunched,
}: {
  lastVersion: string | null;
  version: string;
  databaseExisted: boolean;
  otherChannelLaunched: boolean;
}): TelemetryInstallKind {
  if (lastVersion === null) {
    if (!databaseExisted) return 'new';
    return otherChannelLaunched ? 'same' : 'updated';
  }
  if (lastVersion === version) return 'same';
  return isDowngrade(lastVersion, version) ? 'same' : 'updated';
}

/** Whether `version` is an older release than `lastVersion`, prerelease included. */
function isDowngrade(lastVersion: string, version: string): boolean {
  return (
    semver.valid(lastVersion) !== null &&
    semver.valid(version) !== null &&
    semver.lt(version, lastVersion)
  );
}

/**
 * One record per channel: canary and stable share a database, and comparing
 * one's version with the other's would read every switch between them as an
 * upgrade.
 */
const store = new KV<Record<string, string>>('telemetry-launches');

/**
 * This launch's recording, once boot has started it. Kept as the promise rather
 * than its result, because boot does not wait for it and something can ask
 * before it settles. Settles to null when the launch could not be recorded.
 */
let recording: Promise<TelemetryInstallKind | null> | null = null;

type LaunchInputs = {
  version: string;
  channel: 'canary' | 'stable';
  databaseExisted: boolean;
};

/** Which kind this launch is, and the version the previous launch ran. */
export type LaunchRecord = { kind: TelemetryInstallKind; lastVersion: string | null };

const channelKey = (channel: LaunchInputs['channel']) => `lastLaunchedVersion.${channel}`;

/**
 * Record this launch and say which kind it is. Recorded on every launch,
 * whether or not usage is shared: it is local, and the next launch has to know
 * this one happened to tell an upgrade from a relaunch.
 */
export async function recordLaunch({
  version,
  channel,
  databaseExisted,
}: LaunchInputs): Promise<LaunchRecord> {
  const lastVersion = (await store.get(channelKey(channel))) ?? null;
  const otherChannelLaunched =
    (await store.get(channelKey(channel === 'canary' ? 'stable' : 'canary'))) !== null;
  const kind = installKindFor({ lastVersion, version, databaseExisted, otherChannelLaunched });
  await store.set(channelKey(channel), version);
  return { kind, lastVersion };
}

/** What recording this launch needs, read when boot starts it. */
export async function readThisLaunch(): Promise<LaunchInputs> {
  return {
    version: await resolveAppVersion(),
    channel: IS_CANARY ? 'canary' : 'stable',
    // Imported here, not at the top: the client opens the database on import.
    databaseExisted: (await import('@main/db/client')).databaseExistedAtStart,
  };
}

type LaunchUpdate = Pick<TelemetryEventMap['app_launched'], 'from_version' | 'update_trigger'>;

/**
 * What `app_launched` says about the update an upgrade's launch is the end of:
 * the version it came from, and whether Restart to update installed it.
 */
async function updateOf(record: LaunchRecord): Promise<LaunchUpdate> {
  if (record.kind !== 'updated') return { from_version: 'none', update_trigger: 'none' };
  const from_version = record.lastVersion === null ? 'unknown' : appVersionOf(record.lastVersion);
  try {
    const handedOver = await pendingInstall.take();
    return { from_version, update_trigger: handedOver ? 'restart_button' : 'other' };
  } catch (error) {
    log.warn('telemetry: could not read how this update was installed', { error });
    return { from_version, update_trigger: 'unknown' };
  }
}

/**
 * Record this launch and report it as `app_launched`, with the update it ends
 * when it is an upgrade's. Never rejects, so boot can start it without waiting
 * on it: nothing telemetry does may stop the app opening. A launch that cannot
 * be recorded is logged and goes unreported, rather than reported with a kind
 * nobody worked out.
 */
export async function reportLaunch(read: () => Promise<LaunchInputs>): Promise<void> {
  const recorded = (async () => recordLaunch(await read()))();
  recording = recorded.then(
    (record) => record.kind,
    () => null
  );
  let record: LaunchRecord;
  try {
    record = await recorded;
  } catch (error) {
    log.warn('telemetry: could not record this launch, so app_launched is not sent', { error });
    return;
  }
  trackEvent('app_launched', { install_kind: record.kind, ...(await updateOf(record)) });
}

/**
 * This launch's kind, waited for rather than read: boot does not wait for the
 * recording, so the window can open and the first-run notice be answered before
 * the database has said. Never rejects. A launch that could not be recorded, or
 * that nothing started recording, is `unknown` — never a kind nobody worked out.
 */
export async function launchInstallKind(): Promise<TelemetryInstallKind | 'unknown'> {
  if (recording === null) {
    log.warn('telemetry: install kind asked for, but nothing has recorded this launch');
    return 'unknown';
  }
  return (await recording) ?? 'unknown';
}
