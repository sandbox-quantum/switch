import type { LocationRuntime } from '@main/core/locations/location-runtime';
import type { LifecycleScriptType } from '@shared/core/sessions/sessionEvents';
import { getEffectiveSessionSettings } from '../locations/settings/effective-session-settings';
import { resolveLocationRuntime } from '../locations/utils';

/**
 * Reads the effective lifecycle script config for an already-resolved location
 * runtime. Used by callers that already have one, such as setup/teardown hooks.
 */
export async function resolveLifecycleScriptForRuntime(
  runtime: LocationRuntime,
  type: LifecycleScriptType
): Promise<{ script?: string; shellSetup?: string }> {
  const settings = await getEffectiveSessionSettings({
    locationSettings: runtime.settings,
    sessionFs: runtime.fs,
  });
  return {
    script: settings.scripts?.[type],
    shellSetup: settings.shellSetup,
  };
}

/**
 * Resolves a location runtime by id, then reads the effective lifecycle script
 * config for it. Used by RPC adapters that only receive ids from the renderer.
 */
export async function resolveLifecycleScript({
  locationId,
  type,
}: {
  locationId: string;
  type: LifecycleScriptType;
}): Promise<{ runtime: LocationRuntime; script?: string; shellSetup?: string }> {
  const runtime = resolveLocationRuntime(locationId);
  if (!runtime) throw new Error(`No live runtime for location ${locationId}`);

  const settings = await resolveLifecycleScriptForRuntime(runtime, type);
  return { runtime, ...settings };
}
