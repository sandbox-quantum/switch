import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import type { TelemetryInstallKind } from './events';
import { trackEvent } from './telemetry-service';

/**
 * Which kind of launch this is, from what the last launch recorded.
 *
 * `new` is the first launch an installation ever makes, so counting it counts
 * new installs; `updated` is the first launch on a different version than the
 * last one, an upgrade; `same` is everything else. An installation with a
 * database but no record predates this tracking, and its first launch with it
 * is on a version it was not installed at, so it reads as `updated`.
 */
export function installKindFor({
  lastVersion,
  version,
  databaseExisted,
}: {
  lastVersion: string | null;
  version: string;
  databaseExisted: boolean;
}): TelemetryInstallKind {
  if (lastVersion === null) return databaseExisted ? 'updated' : 'new';
  return lastVersion === version ? 'same' : 'updated';
}

/**
 * One record per channel: canary and stable share a database, and comparing
 * one's version with the other's would read every switch between them as an
 * upgrade.
 */
const store = new KV<Record<string, string>>('telemetry-launches');

let current: TelemetryInstallKind | null = null;

/**
 * Record this launch and say which kind it is. Recorded on every launch,
 * whether or not usage is shared: it is local, and the next launch has to know
 * this one happened to tell an upgrade from a relaunch.
 */
export async function recordLaunch({
  version,
  channel,
  databaseExisted,
}: {
  version: string;
  channel: 'canary' | 'stable';
  databaseExisted: boolean;
}): Promise<TelemetryInstallKind> {
  const key = `lastLaunchedVersion.${channel}`;
  const lastVersion = (await store.get(key)) ?? null;
  current = installKindFor({ lastVersion, version, databaseExisted });
  await store.set(key, version);
  return current;
}

/**
 * Record this launch and report it as `app_launched`. Never rejects, so boot
 * can start it without waiting on it: nothing telemetry does may stop the app
 * opening. A launch that cannot be recorded is logged and goes unreported,
 * rather than reported with a kind nobody worked out.
 */
export async function reportLaunch(
  read: () => Promise<{
    version: string;
    channel: 'canary' | 'stable';
    databaseExisted: boolean;
  }>
): Promise<void> {
  try {
    trackEvent('app_launched', { install_kind: await recordLaunch(await read()) });
  } catch (error) {
    log.warn('telemetry: could not record this launch, so app_launched is not sent', { error });
  }
}

/**
 * This launch's kind. Boot records it before any window opens, so nothing a
 * person does can ask first; if something does, it is said in the log rather
 * than passed off as a real answer, and reads as `same`, the kind that claims
 * nothing.
 */
export function currentInstallKind(): TelemetryInstallKind {
  if (current === null) {
    log.warn('telemetry: install kind read before this launch was recorded');
    return 'same';
  }
  return current;
}
