import { getAgentById } from '@main/core/agents/getAgentById';
import {
  agentSettingsRelativePath,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from '@main/core/agents/switch-settings-paths';
import type { LocationProvider } from '@main/core/locations/location-provider';
import type { LocationRuntime } from '@main/core/locations/location-runtime';
import { locationRuntimeRegistry } from '@main/core/locations/location-runtime-registry';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { events } from '@main/lib/events';
import {
  sessionProvisionProgressChannel,
  type ProvisionStep,
} from '@shared/core/sessions/sessionEvents';
import type { Session } from '@shared/core/sessions/sessions';
import type { AgentRuntimeProvider } from '../agent-runtime/types';
import {
  buildAgentRuntime,
  createLocationRuntimeFactory,
  resolveSessionEnv,
} from '../locations/location-runtime-factory';
import type { LocationSettingsProvider } from '../locations/settings/provider';
import { sessionProvisionEvents } from './session-provision-events';

/**
 * The runtime artefacts of a provisioned session. Every session runs in its
 * agent's location dir; the location runtime is keyed per location and shared
 * by all sessions there.
 */
export type SessionRuntimeResult = {
  path: string;
  locationId: string;
  agent: AgentRuntimeProvider;
};

/**
 * Provisions the runtime for a session: acquires the location runtime (running
 * lifecycle scripts once per location) and builds the session's agent runtime
 * in the location dir.
 */
export async function provisionSessionRuntime(
  session: Session,
  location: LocationProvider
): Promise<SessionRuntimeResult> {
  const locationId = location.locationId;
  const transport = location.transport;
  const workDir = location.dir;

  emitSessionProvisionProgress({
    sessionId: session.id,
    step: 'initialising-location',
    message: 'Initialising location…',
  });

  const runtime = await locationRuntimeRegistry.acquire(
    locationId,
    createLocationRuntimeFactory(locationId, transport, {
      session,
      workDir,
      settings: location.settings,
      logPrefix: 'provisionSessionRuntime',
    })
  );

  emitSessionProvisionProgress({
    sessionId: session.id,
    step: 'starting-sessions',
    message: 'Preparing session…',
  });

  let buildSucceeded = false;
  try {
    const agent = await buildSessionFromRuntime(session, runtime, transport, location.settings);
    buildSucceeded = true;
    return {
      path: workDir,
      locationId,
      agent,
    };
  } finally {
    if (!buildSucceeded) {
      await locationRuntimeRegistry.release(locationId, 'terminate').catch(() => {});
    }
  }
}

export function emitSessionProvisionProgress(data: {
  sessionId: string;
  step: ProvisionStep;
  message: string;
}): void {
  events.emit(sessionProvisionProgressChannel, data);
  sessionProvisionEvents.emitProgress(data);
}

/**
 * Shared tail of the provision flow — builds the session's agent runtime from
 * an already-acquired location runtime. Works for both local and SSH transports.
 */
export async function buildSessionFromRuntime(
  session: Session,
  runtime: LocationRuntime,
  transport: LocationTransport,
  settings: LocationSettingsProvider
): Promise<AgentRuntimeProvider> {
  const { sessionEnvVars, tmuxEnabled, shellSetup } = await resolveSessionEnv(
    session,
    runtime,
    settings
  );

  // The remote preflight verifies the session's own creds file, keyed by the
  // agent's NAME (`.switch/agents/<name>.json`). Resolve the name from the agent
  // row's definitionName — the source of truth, so a session picks up the right
  // name even if it was created (or restored) before the agent was migrated — and
  // fall back to the session's own agentName. The agent-id path and the legacy
  // shared `.claude/settings.local.json` are last-resort fallbacks for agents not
  // yet migrated (CHOO-1440).
  const agent = await getAgentById(session.agentId);
  const slug = agent?.definitionName ?? session.agentName;
  const credsRelPaths = [
    ...(slug ? [agentSettingsRelativePath(slug)] : []),
    agentSettingsRelativePath(session.agentId),
    SWITCH_SETTINGS_RELATIVE_PATH,
  ];

  return buildAgentRuntime(transport, {
    locationId: runtime.id,
    sessionId: session.id,
    sessionPath: runtime.path,
    tmuxEnabled,
    shellSetup,
    sessionEnvVars,
    credsRelPaths,
  });
}
