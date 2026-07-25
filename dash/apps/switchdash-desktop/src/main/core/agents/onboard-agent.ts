import { randomUUID } from 'node:crypto';
import { err, ok } from '@switchdash/shared';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation } from '@main/core/locations/store';
import { readSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { agentExistsOnServer, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type {
  OnboardAgentError,
  OnboardAgentParams,
  OnboardAgentResult,
} from '@shared/core/agents/onboarding';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
import { createAgent } from './createAgent';
import { detectSwitchAgent } from './detect';
import { detectSwitchAgentRemote } from './detect-remote';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';
import { writeAgentNeutralSettings } from './write-switch-settings';

/**
 * Gate agent creation on the chosen server actually owning the detected agent
 * (and on being signed in). Every agent in the app is bound to a usable server
 * it provably exists on. `dir` is used only for error reporting.
 */
async function verifyAgentOnServer(
  serverId: string,
  agentId: string,
  dir: string
): Promise<OnboardAgentError | null> {
  const server = await getServer(serverId);
  if (!server) {
    throw new Error(`No Switch server with id ${serverId}`);
  }
  try {
    const exists = await agentExistsOnServer(server, agentId);
    if (!exists) {
      return {
        type: 'switch-agent-not-on-server',
        dir,
        serverId: server.id,
        serverName: server.name,
        agentId,
      };
    }
    return null;
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
      return {
        type: 'switch-server-unauthenticated',
        dir,
        serverId: server.id,
        serverName: server.name,
      };
    }
    throw cause;
  }
}

/**
 * Enforce that an agent's run location can actually reach a switchdash-managed
 * server: a remote-managed server only from this computer or its own host (the
 * desktop reaches it via the SSH forward; the host on loopback — nothing else
 * has a route); a local-managed server only from this computer. External servers
 * are unconstrained. Returns an error message for an out-of-policy pairing, else
 * null. Mirrors the add-agent modal's picker constraint as a bypass-proof gate.
 */
function managedServerLocationError(server: SwitchServer, sshHost: string | null): string | null {
  if (server.managementKind === 'remote') {
    if (sshHost !== null && sshHost !== server.sshHost) {
      return `This server runs on ${server.sshHost}; its agents can only run on this computer or on ${server.sshHost}.`;
    }
    return null;
  }
  if (server.managementKind === 'local' && sshHost !== null) {
    return 'This server runs on this computer; its agents can only run on this computer.';
  }
  return null;
}

/**
 * Onboard an agent: resolve the Switch identity already configured in the
 * working dir (locally or over SSH), verify it on the chosen server, and
 * create the agent at its location — creating the location row first if this
 * is the first agent there. Identity minting (for a brand-new agent) happens
 * before this call via `switchServers.provisionAgent` / `provisionRemoteAgent`.
 */
export async function onboardAgent(params: OnboardAgentParams): Promise<OnboardAgentResult> {
  const sshHost = params.sshHost ?? null;

  let switchAgent;
  if (sshHost === null) {
    if (!checkIsValidDirectory(params.dir)) {
      return err({ type: 'invalid-directory', dir: params.dir, message: 'Invalid directory' });
    }
    // Onboarding a directory == onboarding a Switch agent. Reject directories
    // that are not configured as one (no `.claude/settings.local.json` block).
    switchAgent = await detectSwitchAgent(params.dir);
  } else {
    switchAgent = await detectSwitchAgentRemote(sshHost, params.dir);
  }
  if (!switchAgent) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message:
        sshHost === null
          ? 'This directory is not configured as a Switch agent. Configure the agent first (run the switch-connector configure skill) before adding it.'
          : `The remote directory ${params.dir} on ${sshHost} is not configured as a Switch agent.`,
    });
  }

  const serverError = await verifyAgentOnServer(params.serverId, switchAgent.agentId, params.dir);
  if (serverError) return err(serverError);

  const server = await getServer(params.serverId);
  if (server) {
    const locationError = managedServerLocationError(server, sshHost);
    if (locationError) {
      return err({ type: 'invalid-directory', dir: params.dir, message: locationError });
    }
  }

  const location = await ensureLocation({ sshHost, dir: params.dir, name: params.name });

  const agent = await createAgent({
    id: params.id ?? randomUUID(),
    locationId: location.id,
    name: basenameFromAnyPath(params.dir) || params.providerId,
    providerId: params.providerId,
    switchAgentId: switchAgent.agentId,
    apiEndpoint: switchAgent.apiEndpoint,
    serverId: params.serverId,
    // Honor an explicit choice from the add-agent modal; otherwise default by
    // run location — remote agents run unattended on their VM with no operator
    // to answer permission prompts, so default them to bypass, local off.
    autoApprove: params.autoApprove ?? sshHost !== null,
  });

  // Mirror the agent's credentials into its provider-neutral per-agent file
  // (`.switch/agents/<agentId>.json`), the authoritative identity switchdash
  // injects at launch so agents sharing a location don't collide on the single
  // `.claude/settings.local.json` identity (CHOO-1440). Local agents only — a
  // remote agent's dir lives on its VM. Best-effort: the launch/poller fall back
  // to `settings.local.json`, so a failure here does not break onboarding.
  if (sshHost === null) {
    const creds = await readSwitchAgentCredentials(params.dir, log);
    if (creds) {
      await writeAgentNeutralSettings({
        dir: params.dir,
        slug: agent.id,
        apiEndpoint: creds.apiEndpoint,
        apiToken: creds.token,
        agentId: creds.agentId,
      }).catch((error) => {
        log.warn('onboardAgent: failed to write neutral agent settings', {
          agentId: agent.id,
          error: String(error),
        });
      });
    }
  }

  // Seed the local auto_session mirror + start the watcher from the gateway
  // profile so an agent registered with auto_session on starts watching now,
  // without the operator toggling it off→on (CHOO-1185). Best-effort: a gateway
  // hiccup must not fail onboarding — the settings panel reconciles later.
  await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
    log.warn('onboardAgent: failed to reconcile auto_session for new agent', {
      agentId: agent.id,
      error: String(error),
    });
  });

  await locationManager.openLocation(location);
  agentEvents._emit('agent:created', agent);
  return ok(agent);
}
