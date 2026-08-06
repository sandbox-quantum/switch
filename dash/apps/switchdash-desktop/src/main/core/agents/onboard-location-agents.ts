import { randomUUID } from 'node:crypto';
import { err, ok } from '@switchdash/shared';
import type { Result } from '@switchdash/shared';
import { knownAgentTypeForProvider } from '@main/core/agents/known-agent-type';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { agentExistsOnServer, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { OnboardAgentError } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
import { resolveWorkspaceFsFor, type WorkspaceFs } from './agent-workspace-fs';
import { createAgent } from './createAgent';
import { getAgents } from './getAgents';
import { registerAgentIdentity } from './register-agent-identity';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';
import { writeNeutralAgentSettingsFs } from './write-switch-settings';

export type OnboardLocationParams = {
  sshHost: string | null;
  dir: string;
  locationName?: string;
  providerId: AgentProviderId;
  /** The registered Switch server the discovered agents belong to (or are
   * adopted onto, for plain provider subagents with no Switch setup yet). */
  serverId: string;
  /** Definition names to onboard. When omitted, every onboardable definition in
   * the directory is onboarded; when given, only these are (the modal's
   * multi-select). Names not currently onboardable are ignored. */
  names?: string[];
};

export type OnboardLocationResult = Result<Agent[], OnboardAgentError>;

/** The Switch identity an onboarded definition should run under. */
type ResolvedIdentity = { switchAgentId: string; apiEndpoint: string };

/** Map a recoverable registration failure to an onboard error. */
function registrationError(
  kind: 'unauthenticated' | 'name-conflict' | 'invalid-name' | 'error',
  message: string,
  name: string,
  server: SwitchServer,
  dir: string
): OnboardAgentError {
  if (kind === 'unauthenticated') {
    return {
      type: 'switch-server-unauthenticated',
      dir,
      serverId: server.id,
      serverName: server.name,
    };
  }
  if (kind === 'name-conflict') {
    return {
      type: 'error',
      message: `An agent named "${name}" already exists on ${server.name}. Rename the definition or delete the conflicting agent.`,
    };
  }
  return { type: 'error', message };
}

/**
 * Resolve the Switch identity to onboard a definition under: reuse existing
 * credentials when their identity still exists on the server, otherwise register
 * a fresh identity and write the credentials (adopting a plain subagent).
 */
async function resolveIdentity(
  name: string,
  description: string | null,
  ctx: {
    server: SwitchServer;
    workspace: WorkspaceFs;
    credsByName: Map<string, { switchAgentId: string | null; apiEndpoint: string | null }>;
    dir: string;
  }
): Promise<{ ok: true; identity: ResolvedIdentity } | { ok: false; error: OnboardAgentError }> {
  const creds = ctx.credsByName.get(name);
  if (creds?.switchAgentId && creds.apiEndpoint) {
    try {
      if (await agentExistsOnServer(ctx.server, creds.switchAgentId)) {
        return {
          ok: true,
          identity: { switchAgentId: creds.switchAgentId, apiEndpoint: creds.apiEndpoint },
        };
      }
    } catch (cause) {
      if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
        return {
          ok: false,
          error: {
            type: 'switch-server-unauthenticated',
            dir: ctx.dir,
            serverId: ctx.server.id,
            serverName: ctx.server.name,
          },
        };
      }
      throw cause;
    }
  }

  // No usable credentials — adopt: mint a fresh identity and write its creds,
  // keeping the existing definition file untouched.
  const registered = await registerAgentIdentity(ctx.server, {
    name,
    description: description ?? `Claude Code agent ${name}`,
    repoDir: ctx.dir,
    autoSession: true,
    // This path onboards `.claude/agents/*.md` definitions, so the identity is a
    // Claude Code one by construction.
    agentType: knownAgentTypeForProvider('claude'),
  });
  if (registered.kind !== 'created') {
    const message = 'message' in registered ? registered.message : '';
    return {
      ok: false,
      error: registrationError(registered.kind, message, name, ctx.server, ctx.dir),
    };
  }

  await writeNeutralAgentSettingsFs(ctx.workspace.fs, ctx.workspace.secrets, {
    slug: name,
    apiEndpoint: ctx.server.apiUrl,
    apiToken: registered.apiKey,
    agentId: registered.id,
  });
  return { ok: true, identity: { switchAgentId: registered.id, apiEndpoint: ctx.server.apiUrl } };
}

/**
 * Onboard the provider agents defined in a working directory. Every
 * `.claude/agents/<name>.md` definition that can join Switch and isn't already a
 * switchdash agent is brought in as a flat agent row (CHOO-1440):
 *
 * - A definition that already carries valid Switch credentials (registered, and
 *   its identity still exists on the server) is imported under that identity.
 * - A plain provider subagent (a definition with no Switch setup — e.g. one a
 *   user created directly in Claude Code) is *adopted*: switchdash mints a Switch
 *   identity for it and writes its per-agent credentials, leaving the existing
 *   definition file untouched.
 *
 * There is no "main" agent — the directory is a flat container of
 * repository-defined agents. Local and remote (SSH) directories are both
 * supported.
 */
export async function onboardLocationAgents(
  params: OnboardLocationParams
): Promise<OnboardLocationResult> {
  if (params.sshHost === null && !checkIsValidDirectory(params.dir)) {
    return err({ type: 'invalid-directory', dir: params.dir, message: 'Invalid directory' });
  }

  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const behavior = getPlugin(params.providerId).behavior.repoAgents;
  if (!behavior) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: `Provider ${params.providerId} does not define repository agents.`,
    });
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.providerId,
  });

  const existing = new Set((await getAgents(location.id)).map((a) => a.name));

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  const created: Agent[] = [];
  try {
    const definitions = await behavior.discoverDefinitions(workspace.fs);
    const local = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
    const credsByName = new Map(local.map((l) => [l.name, l]));

    // Onboardable = a definition that can join Switch and isn't already a row.
    const onboardable = definitions.filter((d) => d.eligible && !existing.has(d.name));
    if (onboardable.length === 0) {
      return err({
        type: 'invalid-directory',
        dir: params.dir,
        message: 'No Claude agents available to onboard in this directory.',
      });
    }

    // Restrict to the caller's selection (the modal's multi-select) when given;
    // otherwise onboard every onboardable definition.
    const requested = params.names;
    const selected = requested
      ? onboardable.filter((d) => requested.includes(d.name))
      : onboardable;
    if (selected.length === 0) {
      return err({
        type: 'invalid-directory',
        dir: params.dir,
        message: 'None of the selected agents are available to onboard in this directory.',
      });
    }

    for (const def of selected) {
      const resolved = await resolveIdentity(def.name, def.description, {
        server,
        workspace,
        credsByName,
        dir: params.dir,
      });
      if (!resolved.ok) return err(resolved.error);

      const agent = await createAgent({
        id: randomUUID(),
        locationId: location.id,
        name: def.name,
        providerId: params.providerId,
        switchAgentId: resolved.identity.switchAgentId,
        apiEndpoint: resolved.identity.apiEndpoint,
        serverId: params.serverId,
        autoApprove: params.sshHost !== null,
      });
      existing.add(def.name);
      created.push(agent);

      await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
        log.warn('onboardLocationAgents: failed to reconcile auto_session', {
          agentId: agent.id,
          error: String(error),
        });
      });
    }
  } finally {
    workspace.close();
  }

  if (created.length === 0) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: 'Every agent in this directory is already onboarded here.',
    });
  }

  await locationManager.openLocation(location);
  for (const agent of created) agentEvents._emit('agent:created', agent);
  return ok(created);
}
