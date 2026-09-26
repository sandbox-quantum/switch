import { randomUUID } from 'node:crypto';
import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { eq } from 'drizzle-orm';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation, getLocationByHostDir } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { getServer } from '@main/core/switch-servers/servers-store';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import type { TelemetryAgentCreateFailure } from '@main/core/telemetry/events';
import { entryPointOf } from '@main/core/telemetry/narrow';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { db } from '@main/db/client';
import { agents as agentsTable } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  isAbsoluteRemoteDir,
  isUsableRemoteDir,
  normalizeRemoteDir,
  type RemoteDirInspection,
} from '@shared/core/remote-hosts/remote-dir';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { basenameFromAnyPath } from '@shared/path-name';
import { writeAgentConfigFile } from './agent-config-file';
import type { AgentTemplateOrigin } from './agent-config-file';
import { foreignCredentialsOwner, sameEndpointAgentId } from './agent-credentials-slot';
import { agentEvents } from './agent-events';
import { agentNameTaken } from './agent-name-taken';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { createAgent } from './createAgent';
import { acknowledgeDefinition } from './import-agent-config';
import { knownAgentTypeForProvider } from './known-agent-type';
import { registerAgentIdentity } from './register-agent-identity';
import { inspectRemoteDir } from './remote-dir';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';
import { writeNeutralAgentSettingsFs } from './write-switch-settings';

export type AddAgentParams = {
  id?: string;
  /** Where the agent runs: an `~/.ssh/config` Host alias, or null for this machine. */
  sshHost: string | null;
  /** The working directory (local absolute path, or the repo dir on the host). */
  dir: string;
  /** Display name for the location row when it is created (defaults to the dir basename). */
  locationName?: string;
  /** The agent's name — filesystem-safe; also its provider definition stem and
   * the `--agent <name>` value. */
  name: string;
  providerId: AgentProviderId;
  /** The registered Switch server to mint the identity on. */
  serverId: string;
  description: string;
  /** The human label chat platforms render the agent under. Null means it is
   * shown under `name` instead — `name` stays the routing key either way. */
  displayName: string | null;
  /** The icon picked in the create form. Null means the form offered no
   * choice, and the agent is registered with the avatar its name generates. */
  iconUrl: string | null;
  autoSession: boolean;
  autoApprove: boolean;
  /** The agent's system prompt, provider-agnostic. Rendered into whatever the
   * provider reads — a Claude Code subagent body, Codex's developer
   * instructions. Empty for an agent with none. */
  instructions: string;
  /** Provider-specific definition attributes (model, effort, tools, …), keyed
   * by the provider's attribute fields. `name`/`description` are set from the
   * params above, and the system prompt is `instructions`. */
  definitionAttributes: RepoAgentAttributes;
  /** Per-agent provider config folded into the agent's launch (Codex model /
   * effort / instructions). Distinct from `definitionAttributes`, which is the
   * repo-agent definition surface Codex does not use. */
  providerConfig?: AgentProviderConfig | null;
  /** Which control the user opened the add-agent form from, for reporting. */
  entryPoint: UiEntryPoint;
  /** The template the agent is created from, if any. Recorded so the agent's
   * settings page can offer the template's current instructions later. */
  templateOrigin?: AgentTemplateOrigin | null;
};

export type AddAgentResult =
  | { kind: 'created'; agent: Agent }
  | { kind: 'unauthenticated' }
  | { kind: 'name-conflict' }
  | { kind: 'credentials-conflict'; endpoint: string }
  | { kind: 'already-configured' }
  | { kind: 'invalid-name'; message: string }
  /** The remote working directory cannot be used — `inspection.status` says
   * which way. Reported before anything is minted, so no Switch-side agent is
   * left behind (CHOO-1416). */
  | { kind: 'directory-unusable'; sshHost: string; inspection: RemoteDirInspection }
  | { kind: 'error'; message: string };

/** The result's discriminant as a reportable code. Never its message. */
const ADD_AGENT_FAILURE_REASON: Record<
  Exclude<AddAgentResult['kind'], 'created'>,
  TelemetryAgentCreateFailure
> = {
  unauthenticated: 'unauthenticated',
  'name-conflict': 'name_conflict',
  'credentials-conflict': 'credentials_conflict',
  'already-configured': 'already_configured',
  'invalid-name': 'invalid_name',
  'directory-unusable': 'directory_unusable',
  error: 'error',
};

/**
 * Report a creation that did not happen.
 *
 * Reported here rather than from the `agent:created` hook, which by definition
 * only fires when one succeeded. The location is read from the parameters, not
 * the database: no row exists to look it up from, and the parameters are what
 * the user asked for.
 */
function reportCreateFailure(params: AddAgentParams, reason: TelemetryAgentCreateFailure): void {
  trackEvent('agent_created', {
    agent_type: agentTypeOf(params.providerId),
    location: params.sshHost === null ? 'local' : 'remote',
    outcome: 'failure',
    failure_reason: reason,
    entry_point: entryPointOf(params.entryPoint),
  });
}

/** The same, wrapped around a failing return so it can stay an expression. */
function reportFailedCreate(params: AddAgentParams, result: AddAgentResult): AddAgentResult {
  if (result.kind === 'created') return result;
  reportCreateFailure(params, ADD_AGENT_FAILURE_REASON[result.kind]);
  return result;
}

/**
 * Add a new agent to a location: mint its Switch identity on the gateway, write
 * its config file (`.switch/config/<name>.json`) and its per-agent Switch
 * credentials (`.switch/agents/<name>.json`), both keyed by name, then create the
 * agent row. Every Switch Console-managed agent is a flat, named agent — for a
 * provider that supports definitions each session runs as `<name>` with its own
 * identity; there is no "main" agent and no parent (CHOO-1440).
 *
 * Works for local and remote (SSH) run locations. The minted API token is
 * written to disk and never returned. A recoverable gateway failure is mapped to
 * a typed result the modal can act on; a filesystem failure after registration
 * throws (leaving the gateway agent, as the pre-existing provision path did).
 */
export async function addAgent(input: AddAgentParams): Promise<AddAgentResult> {
  // Canonicalized once here so nothing downstream keys off a different spelling
  // of the same directory.
  const params: AddAgentParams =
    input.sshHost !== null && isAbsoluteRemoteDir(input.dir)
      ? { ...input, dir: normalizeRemoteDir(input.dir) }
      : input;
  try {
    return await runAddAgent(params);
  } catch (error) {
    // The half of the failures that are not a typed return, and the half worth
    // watching most: everything past the identity mint signals failure by
    // throwing, and those are the attempts that leave an agent registered on the
    // gateway with nothing here pointing at it. `error` is the only honest code
    // — these are not a named union, and their messages carry paths.
    reportCreateFailure(params, 'error');
    throw error;
  }
}

async function runAddAgent(params: AddAgentParams): Promise<AddAgentResult> {
  if (params.sshHost === null && !checkIsValidDirectory(params.dir)) {
    return reportFailedCreate(params, {
      kind: 'error',
      message: `Invalid directory: ${params.dir}`,
    });
  }
  // The one case the probe below cannot be asked about: a relative path has no
  // meaning until a session picks a starting directory, so there is nothing on
  // the host to inspect.
  if (params.sshHost !== null && !isAbsoluteRemoteDir(params.dir)) {
    return reportFailedCreate(params, {
      kind: 'directory-unusable',
      sshHost: params.sshHost,
      inspection: { dir: params.dir, status: 'relative' },
    });
  }

  const server = await getServer(params.serverId);
  if (!server) {
    return reportFailedCreate(params, {
      kind: 'error',
      message: `No Switch server with id ${params.serverId}`,
    });
  }

  // Before minting an identity: the gateway's uniqueness check is scoped to the
  // Switch server, so it cannot see a name already taken in this directory. Two
  // same-named agents here would share one `.switch/agents/<name>.json`.
  const existingLocation = await getLocationByHostDir(params.sshHost, params.dir);
  if (existingLocation && (await agentNameTaken(existingLocation.id, params.name, null))) {
    return reportFailedCreate(params, { kind: 'name-conflict' });
  }

  // And the check above only sees agents THIS install manages. A second Switch
  // Console on the same host, pointed at a different Switch server, has its own
  // database and its own agents in this same directory — so the only thing that
  // knows about its agent is the credentials file it left here (CHOO-1960).
  // Refuse before minting: the writer refuses too, but by then this agent's
  // token has been minted and is unrecoverable.
  const foreignEndpoint = await foreignCredentialsOwner(
    params.sshHost,
    params.dir,
    params.name,
    server.apiUrl
  );
  if (foreignEndpoint !== null) {
    return reportFailedCreate(params, {
      kind: 'credentials-conflict',
      endpoint: foreignEndpoint,
    });
  }

  // The cross-deployment check above passes when the slot belongs to the SAME
  // server. That is safe when this install already manages the agent (the
  // agentNameTaken check above covers it), but not when the file was written by another
  // Console — its agent is in this install's blind spot. Minting here would
  // overwrite the existing identity and destroy its token (CHOO-2560).
  const slotAgentId = await sameEndpointAgentId(
    params.sshHost,
    params.dir,
    params.name,
    server.apiUrl
  );
  if (slotAgentId !== null) {
    const [knownLocally] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.switchAgentId, slotAgentId))
      .limit(1);
    if (!knownLocally) {
      return reportFailedCreate(params, { kind: 'already-configured' });
    }
  }

  // The last check before minting, and the only one costing a round trip to the
  // host — hence last, so a name conflict is answered without an SSH probe. A
  // missing directory under an existing parent passes: the first write creates
  // it (CHOO-1416).
  if (params.sshHost !== null) {
    const inspection = await inspectRemoteDir(params.sshHost, params.dir);
    if (!isUsableRemoteDir(inspection)) {
      return reportFailedCreate(params, {
        kind: 'directory-unusable',
        sshHost: params.sshHost,
        inspection,
      });
    }
  }

  const registered = await registerAgentIdentity(server, {
    name: params.name,
    description: params.description,
    displayName: params.displayName,
    repoDir: params.dir,
    autoSession: params.autoSession,
    agentType: knownAgentTypeForProvider(params.providerId),
    iconUrl: params.iconUrl ?? agentAvatarUrlForName(params.name),
  });
  if (registered.kind !== 'created') return reportFailedCreate(params, registered);

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    // Writing the per-agent Switch credentials is unconditional core behavior for
    // every provider, keyed by the agent's `name` — the single key-space every
    // reader (launch path, auto-session watcher, notification poller) uses
    // (CHOO-1440).
    await writeNeutralAgentSettingsFs(workspace.fs, {
      slug: params.name,
      apiEndpoint: server.apiUrl,
      apiToken: registered.apiKey,
      agentId: registered.id,
      expectedAgentId: slotAgentId ?? undefined,
    });
    // The config file is the agent's whole configuration: each launch builds
    // what the provider needs from it. A definition an earlier agent of this
    // name left behind is recorded as accounted for, so nothing takes it for an
    // edit to this one.
    await writeAgentConfigFile(
      workspace.fs,
      params.name,
      await acknowledgeDefinition({
        workspaceFs: workspace.fs,
        repoAgents: getPlugin(params.providerId).behavior.repoAgents ?? null,
        name: params.name,
        config: {
          description: params.description,
          instructions: params.instructions,
          settings: params.definitionAttributes,
          ...(params.templateOrigin ? { template: params.templateOrigin } : {}),
        },
      })
    );
  } finally {
    workspace.close();
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.name,
  });

  const agent = await createAgent({
    id: params.id ?? randomUUID(),
    locationId: location.id,
    name: params.name,
    providerId: params.providerId,
    switchAgentId: registered.id,
    apiEndpoint: server.apiUrl,
    serverId: params.serverId,
    autoApprove: params.autoApprove,
    providerConfig: params.providerConfig ?? null,
  });

  // Seed the local auto_session mirror + watcher from the gateway profile so an
  // agent registered with auto_session on starts watching now, without an
  // off→on toggle. Best-effort: a gateway hiccup must not fail creation.
  await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
    log.warn('addAgent: failed to reconcile auto_session for new agent', {
      agentId: agent.id,
      error: String(error),
    });
  });

  await locationManager.openLocation(location);
  agentEvents._emit('agent:created', agent, params.entryPoint);
  return { kind: 'created', agent };
}
