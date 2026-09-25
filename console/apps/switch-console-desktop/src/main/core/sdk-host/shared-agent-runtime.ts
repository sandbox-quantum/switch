import {
  CommandNotRecordedError,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';
import { stopSharedSession } from './stop-shared-session';
export { stopSharedSession } from './stop-shared-session';
import { reconcileInitialPrompt } from './initial-prompt';
import { stopLegacySidecar } from './legacy-sidecar';
import { readLocalHostFailure, startLocalSession } from './local-host';
import { deploySharedHost } from './shared-host-deployment';
import { withSidecar } from './sidecar-control';
export { deploySharedHost } from './shared-host-deployment';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  sharedConfigSchema,
  sharedSessionRoot,
  type SharedHostConfig,
} from '@switch-console/agent-providers';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '@switch-console/plugins/switch-skill';
import { commandStatusSchema, type Snapshot } from '@switch-console/shared/session-v1';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentLaunchSpecialization } from '@main/core/agents/agent-launch-config';
import { getAgentById } from '@main/core/agents/getAgentById';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { ensureServerSessionReady } from '@main/core/managed-switch-server/session-readiness';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { AGENT_ENV_VARS } from '@main/core/sdk-host/agent-env';
import { setInitialPromptDelivery } from '@main/core/sessions/operations/set-initial-prompt-delivery';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { controllerConnectionId } from '@main/core/switch-rooms/session-connection-id';
import { getPersistedRoomConnection } from '@main/core/switch-rooms/session-room-store';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { makeHookSessionId } from '@shared/core/providers/hook-session-id';
import type { Session } from '@shared/core/sessions/sessions';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { JournalUnavailableError } from './host-journal';
import { currentSnapshot } from './transcripts';

/** A host that stopped on an interrupted reset is online and waits for the user's explicit reset. */
function awaitingResetDecision(snapshot: Snapshot): boolean {
  return (
    snapshot.session.status === 'error' &&
    snapshot.session.capabilities.reset === true &&
    !snapshot.turns.some((turn) => turn.status === 'queued' || turn.status === 'running') &&
    !snapshot.requests.some((request) => request.state === 'open' || request.state === 'submitting')
  );
}

function launchSettled(snapshot: Snapshot): boolean {
  return (
    ['ready', 'running', 'stopped'].includes(snapshot.session.status) ||
    awaitingResetDecision(snapshot)
  );
}

export class SharedAgentRuntime implements AgentRuntimeProvider {
  private server: SwitchServer | null = null;
  private starting: Promise<void> | null = null;
  private opened: Promise<void> | null = null;
  private startupError: string | null = null;
  private startupStage = 'Preparing the session…';

  startupStatus() {
    return {
      status: this.startupError
        ? ('error' as const)
        : this.starting
          ? ('starting' as const)
          : ('ready' as const),
      message: this.startupError ?? (this.starting ? this.startupStage : null),
    };
  }
  constructor(
    private readonly transport: LocationTransport,
    private readonly params: {
      sessionId: string;
      sessionPath: string;
      sessionEnvVars: Record<string, string>;
      shellSetup?: string;
    }
  ) {}

  async start(session: Session, isResuming?: boolean, initialPrompt?: string): Promise<void> {
    if (this.starting) return this.opened ?? this.starting;
    this.startupError = null;
    let connected!: () => void;
    let failed!: (error: unknown) => void;
    this.opened = new Promise<void>((resolve, reject) => {
      connected = resolve;
      failed = reject;
    });
    this.starting = this.open(session, initialPrompt, isResuming ?? false, false, connected);
    void this.starting
      .then(connected, (error: unknown) => {
        this.startupError = error instanceof Error ? error.message : String(error);
        log.error('Background session startup failed', {
          sessionId: session.id,
          error: this.startupError,
        });
        failed(error);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.opened;
  }

  private async open(
    session: Session,
    initialPrompt: string | undefined,
    isResuming: boolean,
    restart: boolean,
    connected: () => void
  ): Promise<void> {
    this.startupStage = 'Preparing the session on its host…';
    const agent = await getAgentById(session.agentId);
    if (!agent?.switchAgentId || !agent.serverId)
      throw new Error('Link this agent to a Switch server before starting a session.');
    this.server = await getServer(agent.serverId);
    if (!this.server) throw new Error('The agent’s Switch server is missing.');
    this.startupStage = 'Waiting for the Switch server to be ready…';
    await ensureServerSessionReady(this.server);
    this.startupStage = 'Preparing the session on its host…';
    const intended = switchNotificationPoller.getSharedIntent(session.id, agent.switchAgentId);
    const config = await buildSharedHostConfig(session, this.params, this.transport);
    const previousEpoch = restart ? await journalEpoch(session.agentId, session.id) : null;
    let root: string;
    let readFailure: () => Promise<unknown>;
    this.startupStage = restart
      ? 'Stopping the previous process and starting its replacement…'
      : 'Starting the session process…';
    if (this.transport.kind === 'ssh') {
      const deployed = await deploySharedHost(
        this.transport,
        this.params.sessionPath,
        session.id,
        false
      );
      root = deployed.root;
      await stopLegacySidecar(
        deployed.ctx,
        this.params.sessionPath,
        config.execution!.credentialsPath
      );
      readFailure = async () => {
        const result = await deployed.ctx.exec('node', [
          '-e',
          "const fs=require('node:fs');try{console.log(fs.readFileSync(process.argv[1],'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;console.log('null')}",
          posix.join(deployed.root, 'supervisor', 'failure.json'),
        ]);
        return JSON.parse(result.stdout);
      };
      // Started by the agent's sidecar, which is then its parent: it talks to
      // the session over IPC, and Console reaches it through the sidecar.
      await withSidecar(session.agentId, (client) =>
        client.ensure({ config, resuming: isResuming, restart })
      );
    } else {
      // A local session is supervised by Console, so it ends when Console does.
      root = sharedSessionRoot(session.id);
      readFailure = () => readLocalHostFailure(root);
      await startLocalSession(root, config, { resuming: isResuming, restart });
    }
    this.startupStage = 'Connecting to the session host…';
    let roomBound = false;
    const bindRoom = async () => {
      if (roomBound) return;
      const roomContext = {
        sessionId: session.id,
        providerId: session.providerId,
        ptyId: makeHookSessionId(session.providerId, session.id),
      };
      if (intended.rooms[0])
        switchRoomService.setSessionRoom(roomContext, intended.rooms[0], agent.switchAgentId, null);
      else await switchRoomService.restoreConnection(roomContext);
      switchNotificationPoller.clearSharedIntent(session.id);
      roomBound = true;
    };
    let snapshot;
    const deadline = Date.now() + 120000;
    let nextFailureCheck = 0;
    // Quick at first, when the host usually answers within a beat, then
    // slower: a host still installing its provider can take a minute, and
    // every wait here is a read of the whole session from Switch.
    let pause = 50;
    let reported = '';
    while (Date.now() < deadline) {
      if (Date.now() >= nextFailureCheck) {
        const failure = await readFailure();
        if (failure && typeof failure === 'object' && 'message' in failure)
          throw new Error(`Shared SDK host failed: ${String(failure.message)}`);
        nextFailureCheck = Date.now() + 2000;
      }
      try {
        snapshot = await currentSnapshot(session.agentId, session.id);
        if (
          snapshot.session.epoch !== previousEpoch &&
          snapshot.session.connectivity === 'online' &&
          snapshot.session.status === 'starting'
        ) {
          this.startupStage = 'Initializing the provider and checking authentication…';
          await bindRoom();
          connected();
        }
        if (
          snapshot.session.epoch !== previousEpoch &&
          snapshot.session.connectivity === 'online' &&
          launchSettled(snapshot)
        )
          break;
      } catch (error) {
        if (Date.now() + 500 >= deadline) throw error;
        // No journal yet is the host not having started, which is the wait itself.
        const notYet = error instanceof JournalUnavailableError;
        if (!notYet && String(error) !== reported) {
          reported = String(error);
          log.warn('Shared SDK host readiness check failed; still waiting', {
            sessionId: session.id,
            error: reported,
          });
        }
      }
      await delay(pause);
      pause = Math.min(pause * 1.5, 1000);
    }
    if (
      !snapshot ||
      snapshot.session.epoch === previousEpoch ||
      snapshot.session.connectivity !== 'online' ||
      !launchSettled(snapshot)
    )
      throw new Error(
        `Shared SDK host did not become ready. Inspect ${root}/supervisor.log on the execution host.`
      );
    await bindRoom();
    if (!awaitingResetDecision(snapshot))
      await this.deliverInitialPrompt(session, initialPrompt, snapshot);
  }

  private async deliverInitialPrompt(
    session: Session,
    initialPrompt: string | undefined,
    snapshot: Snapshot
  ): Promise<void> {
    const epoch = snapshot.session.epoch;
    const saved = (await loadSessionWithAgent(session.id))?.row.config;
    const prompt = (saved?.initialPrompt ?? initialPrompt)?.trim();
    if (!prompt) return;
    const outcome = await reconcileInitialPrompt({
      prompt,
      epoch,
      record: saved?.initialPromptDelivery,
      legacyCommandId: `initial-${session.id}`,
      hasPriorActivity: snapshot.turns.length > 0 || snapshot.items.length > 0,
      lookup: async (commandId) => {
        try {
          const status = await sessionCommandStatus(session.agentId, session.id, commandId);
          return {
            recorded: true,
            status: status.status,
            code: status.code,
            message: status.message,
          };
        } catch (error) {
          if (error instanceof CommandNotRecordedError) return { recorded: false };
          throw error;
        }
      },
      persist: (record) => setInitialPromptDelivery(session.id, record),
      submit: async (commandId, commandEpoch) => {
        const receipt = commandStatusSchema.parse(
          await submitSessionCommand(session.agentId, {
            contractVersion: 1,
            sessionId: session.id,
            epoch: commandEpoch,
            commandId,
            body: {
              type: 'message.send',
              text: prompt,
              attachments: [],
              delivery: 'queue',
            },
          })
        );
        return {
          recorded: true,
          status: receipt.status,
          code: receipt.code,
          message: receipt.message,
        };
      },
      newCommandId: () => randomUUID(),
      now: () => new Date().toISOString(),
    });
    // An undelivered prompt leaves the session open and usable, so it is
    // reported rather than fatal.
    if (outcome.action === 'unresolved')
      log.warn('Initial prompt delivery is unresolved', {
        event: 'sdk_host.initial_prompt',
        stage: 'unresolved',
        sessionId: session.id,
        commandId: outcome.record.commandId,
        reason: outcome.record.reason,
      });
    if (outcome.action === 'rejected')
      log.error('Initial prompt was rejected', {
        event: 'sdk_host.initial_prompt',
        stage: 'rejected',
        sessionId: session.id,
        commandId: outcome.record.commandId,
        errorCode: outcome.record.code,
        detail: outcome.record.message,
      });
  }

  async restart(session: Session): Promise<void> {
    await this.resolveServer();
    if (this.starting) await this.starting;
    this.startupError = null;
    this.starting = this.open(session, undefined, true, true, () => {});
    try {
      await this.starting;
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async dehydrate(): Promise<void> {}
  async detach(): Promise<void> {}
  async destroy(): Promise<void> {
    await this.stop();
  }
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    const joined = await loadSessionWithAgent(this.params.sessionId);
    if (!joined) throw new Error('The session is no longer recorded in Console.');
    await stopSharedSession(joined.row.agentId, this.params.sessionId);
  }
  private async resolveServer(): Promise<void> {
    if (this.server) return;
    const session = await loadSessionWithAgent(this.params.sessionId);
    this.server = session?.serverId ? await getServer(session.serverId) : null;
    if (!this.server) throw new Error('The session’s Switch server is missing.');
  }
}

export async function buildSharedHostConfig(
  session: Pick<Session, 'id' | 'agentId' | 'providerId' | 'agentName' | 'providerSessionId'>,
  params: { sessionPath: string; sessionEnvVars: Record<string, string>; shellSetup?: string },
  transport: LocationTransport
): Promise<SharedHostConfig> {
  const agent = await getAgentById(session.agentId);
  if (!agent?.switchAgentId) throw new Error('Link the agent to Switch before launching its host.');
  const specialization = (await agentLaunchSpecialization(session.agentId)) ?? {};
  if (!providerAdapterRegistry.supports(session.providerId))
    throw new Error(
      'SDK sessions support Claude Code, Codex, OpenCode, Antigravity and Cursor. Choose one of these providers.'
    );
  if (transport.kind !== 'ssh' && process.platform === 'win32')
    throw new Error(
      'Persistent SDK sessions require a POSIX execution host. Configure an SSH host for Windows Console.'
    );
  const provider = sharedConfigSchema.shape.start.shape.provider.parse(session.providerId);
  const selection = await hostDependencyStore.getSelection(
    transport.kind === 'ssh' ? transport.connectionId : 'local',
    provider
  );
  const binaryPath =
    selection?.kind === 'pinned'
      ? selection.realpath
      : selection?.kind === 'path'
        ? selection.path
        : selection?.kind === 'cli'
          ? selection.command
          : undefined;
  const capabilities = providerAdapterRegistry.get(provider).capabilities;
  const slug = session.agentName ?? agent.name ?? agent.id;
  const profile =
    provider === 'codex'
      ? getPlugin(provider).behavior.mcp?.launchProfile?.({
          slug,
          workingDir: params.sessionPath,
          values: specialization,
        })
      : undefined;
  const optionKey = provider === 'opencode' ? 'variant' : 'effort';
  const optionValue = specialization[optionKey];
  const persistedRoom = await getPersistedRoomConnection(session.id);
  const config: SharedHostConfig = {
    session: {
      sessionId: session.id,
      agentId: agent.switchAgentId,
      hostId: randomUUID(),
      epoch: randomUUID(),
      provider,
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: capabilities.approvals,
        questions: capabilities.userInput,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider,
      input: {
        sessionId: session.id,
        cwd: params.sessionPath,
        runtimeMode: agent.autoApprove ? 'full-access' : 'approval-required',
        env: params.sessionEnvVars,
        mcpServers: {},
        ...(session.providerSessionId
          ? { resume: { nativeSessionId: session.providerSessionId } }
          : {}),
        ...(specialization.model
          ? {
              model: {
                id: specialization.model,
                ...(optionValue ? { options: { [optionKey]: optionValue } } : {}),
              },
            }
          : {}),
      },
    },
    // Every session of an agent is reached over that agent's one connection,
    // held by its controller, so the identity is derived rather than minted:
    // a session that restarts binds to the same one it did before.
    roomConnection: {
      connectionId: controllerConnectionId(agent.switchAgentId),
      ...(persistedRoom?.switchAgentId === agent.switchAgentId
        ? { restoreRoomId: persistedRoom.roomId }
        : {}),
    },
    execution: {
      credentialsPath: (transport.kind === 'ssh' ? posix.join : join)(
        params.sessionPath,
        agentSettingsRelativePath(slug)
      ),
      inheritEnv: [
        ...AGENT_ENV_VARS,
        'PATH',
        'HOME',
        'USER',
        'SHELL',
        'TMPDIR',
        'LANG',
        'TERM',
        'SSH_AUTH_SOCK',
      ],
      ...(binaryPath ? { binaryPath } : {}),
      ...(params.shellSetup ? { shellSetup: params.shellSetup } : {}),
      ...(getPlugin(provider).behavior.repoAgents
        ? {
            agentDefinition: {
              name: slug,
              path: getPlugin(provider).behavior.repoAgents!.definitionPath(slug),
            },
          }
        : {}),
      codexConfig: profile?.files.map((file) => file.content).join('\n') ?? '',
      // Codex and OpenCode load the skill as a file; the others take it as
      // system context.
      skill: provider === 'codex' || provider === 'opencode' ? SWITCH_SKILL_FILE : '',
      context: [
        provider === 'codex' || provider === 'opencode' ? '' : SWITCH_SKILL_CONTEXT,
        specialization.instructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  };
  return config;
}

/** The generation a session's host last recorded, or null if it has recorded none. */
async function journalEpoch(agentId: string, sessionId: string): Promise<string | null> {
  try {
    return (await currentSnapshot(agentId, sessionId)).session.epoch;
  } catch (error) {
    if (error instanceof JournalUnavailableError) return null;
    throw error;
  }
}
