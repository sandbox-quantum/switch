import { deploySharedHost } from './shared-host-deployment';
export { deploySharedHost } from './shared-host-deployment';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sharedConfigSchema, type SharedHostConfig } from '@switch-console/agent-providers';
import { CODEX_SKILL_CONTENT } from '@switch-console/plugins/agents/codex/skill';
import { CURSOR_SKILL_CONTENT } from '@switch-console/plugins/agents/cursor/skill';
import { GEMINI_SKILL_CONTENT } from '@switch-console/plugins/agents/gemini/skill';
import { SWITCH_AGENT_RUNTIME_PIN } from '@switch-console/plugins/distribution';
import { commandStatusSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentLaunchSpecialization } from '@main/core/agents/agent-launch-config';
import { getAgentById } from '@main/core/agents/getAgentById';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { AGENT_ENV_VARS } from '@main/core/pty/pty-env';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import {
  fetchSdkCommandStatus,
  fetchSdkSnapshot,
  submitSdkCommand,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { makePtyId } from '@shared/core/pty/ptyId';
import type { Session } from '@shared/core/sessions/sessions';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

export class SharedAgentRuntime implements AgentRuntimeProvider {
  private server: SwitchServer | null = null;
  private starting: Promise<void> | null = null;
  constructor(
    private readonly transport: LocationTransport,
    private readonly params: {
      sessionId: string;
      sessionPath: string;
      sessionEnvVars: Record<string, string>;
      shellSetup?: string;
    }
  ) {}

  async start(
    session: Session,
    _size?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.open(session, initialPrompt, isResuming ?? false, false);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async open(
    session: Session,
    initialPrompt: string | undefined,
    isResuming: boolean,
    restart: boolean
  ): Promise<void> {
    const agent = await getAgentById(session.agentId);
    if (!agent?.switchAgentId || !agent.serverId)
      throw new Error('Link this agent to a Switch server before starting a session.');
    this.server = await getServer(agent.serverId);
    if (!this.server) throw new Error('The agent’s Switch server is missing.');
    const intended = switchNotificationPoller.takeSharedIntent(session.id, agent.switchAgentId);
    const config = await buildSharedHostConfig(session, this.params, this.transport, intended);
    const previousEpoch = restart
      ? snapshotSchema.parse(await fetchSdkSnapshot(this.server, session.id)).session.epoch
      : null;
    const { ctx, root, entrypoint } = await deploySharedHost(
      this.transport,
      this.params.sessionPath,
      session.id,
      false
    );
    const launched = await ctx.exec('node', [
      entrypoint,
      root,
      Buffer.from(JSON.stringify(config)).toString('base64'),
      restart ? '--restart' : '--ensure',
      String(isResuming),
    ]);
    const created = JSON.parse(launched.stdout).created === true;
    let snapshot;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        snapshot = snapshotSchema.parse(await fetchSdkSnapshot(this.server, session.id));
        if (
          snapshot.session.epoch !== previousEpoch &&
          snapshot.session.connectivity === 'online' &&
          ['ready', 'running', 'stopped'].includes(snapshot.session.status)
        )
          break;
      } catch (error) {
        if (Date.now() + 500 >= deadline) throw error;
      }
      await delay(500);
    }
    if (
      !snapshot ||
      snapshot.session.epoch === previousEpoch ||
      snapshot.session.connectivity !== 'online' ||
      !['ready', 'running', 'stopped'].includes(snapshot.session.status)
    )
      throw new Error(
        `Shared SDK host did not become ready. Inspect ${root}/supervisor.log on the execution host.`
      );
    const roomContext = {
      sessionId: session.id,
      providerId: session.providerId,
      ptyId: makePtyId(session.providerId, session.id),
    };
    if (intended.rooms[0])
      switchRoomService.setSessionRoom(roomContext, intended.rooms[0], agent.switchAgentId, null);
    else await switchRoomService.restoreConnection(roomContext);
    if (created && initialPrompt?.trim())
      await submitSdkCommand(this.server, {
        contractVersion: 1,
        sessionId: session.id,
        epoch: snapshot.session.epoch,
        commandId: `initial-${session.id}`,
        body: {
          type: 'message.send',
          text: initialPrompt.trim(),
          attachments: [],
          delivery: 'queue',
        },
      });
  }

  async restart(session: Session): Promise<void> {
    await this.resolveServer();
    const snapshot = snapshotSchema.parse(await fetchSdkSnapshot(this.server!, session.id));
    if (snapshot.session.status === 'stopped')
      throw new Error(
        'This session was stopped. Create a new session to start another conversation.'
      );
    await this.open(session, undefined, true, true);
  }

  async dehydrate(): Promise<void> {}
  async detach(): Promise<void> {}
  async destroy(): Promise<void> {
    await this.stop();
  }
  async stop(): Promise<void> {
    if (this.starting) await this.starting;
    await this.resolveServer();
    await stopSharedSession(this.server!, this.params.sessionId);
  }
  private async resolveServer(): Promise<void> {
    if (this.server) return;
    const session = await loadSessionWithAgent(this.params.sessionId);
    this.server = session?.serverId ? await getServer(session.serverId) : null;
    if (!this.server) throw new Error('The session’s Switch server is missing.');
  }
}

export async function buildSharedHostConfig(
  session: Pick<
    Session,
    'id' | 'agentId' | 'providerId' | 'agentName' | 'providerSessionId' | 'autoApprove'
  >,
  params: { sessionPath: string; sessionEnvVars: Record<string, string>; shellSetup?: string },
  transport: LocationTransport,
  intended: { rooms: string[]; startCursor?: number }
): Promise<SharedHostConfig> {
  const agent = await getAgentById(session.agentId);
  if (!agent?.switchAgentId) throw new Error('Link the agent to Switch before launching its host.');
  const specialization = (await agentLaunchSpecialization(session.agentId)) ?? {};
  if (!providerAdapterRegistry.supports(session.providerId))
    throw new Error(
      'SDK sessions support Claude Code, Codex, OpenCode, Gemini and Cursor. Choose one of these providers.'
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
        runtimeMode:
          (session.autoApprove ?? agent.autoApprove) ? 'full-access' : 'approval-required',
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
    roomConnection: {
      connectionId: randomUUID(),
      rooms: intended.rooms,
      startCursor: intended.startCursor,
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
        'GEMINI_CLI_HOME',
      ],
      mcpRuntime: SWITCH_AGENT_RUNTIME_PIN,
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
      skill: provider === 'codex' ? CODEX_SKILL_CONTENT : '',
      context: [
        provider === 'gemini'
          ? GEMINI_SKILL_CONTENT
          : provider === 'cursor'
            ? CURSOR_SKILL_CONTENT
            : '',
        specialization.instructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  };
  return config;
}

export async function stopSharedSession(server: SwitchServer, sessionId: string): Promise<void> {
  const snapshot = snapshotSchema.parse(await fetchSdkSnapshot(server, sessionId));
  if (snapshot.session.status === 'stopped') return;
  const commandId = `stop-${snapshot.session.epoch}`;
  await submitSdkCommand(server, {
    contractVersion: 1,
    sessionId: sessionId,
    epoch: snapshot.session.epoch,
    commandId,
    body: { type: 'session.stop' },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = commandStatusSchema.parse(
      await fetchSdkCommandStatus(server, sessionId, commandId)
    );
    if (receipt.status === 'applied') return;
    if (receipt.status === 'unknown' || receipt.status === 'rejected')
      throw new Error(receipt.message ?? `Stop ${receipt.status}.`);
    await delay(500);
  }
  throw new Error('Stop delivery has not been confirmed. Check the session before retrying.');
}
