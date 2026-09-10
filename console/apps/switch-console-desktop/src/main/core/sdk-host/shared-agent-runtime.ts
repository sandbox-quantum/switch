import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sharedConfigSchema, type SharedHostConfig } from '@switch-console/agent-providers';
import { CODEX_SKILL_CONTENT } from '@switch-console/plugins/agents/codex/skill';
import { CURSOR_SKILL_CONTENT } from '@switch-console/plugins/agents/cursor/skill';
import { GEMINI_SKILL_CONTENT } from '@switch-console/plugins/agents/gemini/skill';
import { SWITCH_AGENT_RUNTIME_PIN } from '@switch-console/plugins/distribution';
import { commandStatusSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentLaunchSpecialization } from '@main/core/agents/agent-launch-config';
import { getAgentById } from '@main/core/agents/getAgentById';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { LocationTransport } from '@main/core/locations/location-transport';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { AGENT_ENV_VARS } from '@main/core/pty/pty-env';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import {
  fetchSdkCommandStatus,
  fetchSdkSnapshot,
  submitSdkCommand,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
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
    }
  ) {}

  async start(
    session: Session,
    _size?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.open(session, initialPrompt, isResuming ?? false);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async open(
    session: Session,
    initialPrompt: string | undefined,
    isResuming: boolean
  ): Promise<void> {
    const agent = await getAgentById(session.agentId);
    if (!agent?.switchAgentId || !agent.serverId)
      throw new Error('Link this agent to a Switch server before starting a session.');
    this.server = await getServer(agent.serverId);
    if (!this.server) throw new Error('The agent’s Switch server is missing.');
    const intended = switchNotificationPoller.takeSharedIntent(session.id, agent.switchAgentId);
    const config = await buildSharedHostConfig(session, this.params, this.transport, intended);
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
      '--ensure',
      String(isResuming),
    ]);
    const created = JSON.parse(launched.stdout).created === true;
    let snapshot;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        snapshot = snapshotSchema.parse(await fetchSdkSnapshot(this.server, session.id));
        if (
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
      snapshot.session.connectivity !== 'online' ||
      !['ready', 'running', 'stopped'].includes(snapshot.session.status)
    )
      throw new Error(
        `Shared SDK host did not become ready. Inspect ${root}/supervisor.log on the execution host.`
      );
    if (created && initialPrompt?.trim() && !intended.rooms.length)
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

  async dehydrate(): Promise<void> {}
  async detach(): Promise<void> {}
  async destroy(): Promise<void> {
    await this.stop();
  }
  async stop(): Promise<void> {
    if (!this.server) throw new Error('Reconnect the shared session before stopping it.');
    const snapshot = snapshotSchema.parse(
      await fetchSdkSnapshot(this.server, this.params.sessionId)
    );
    if (snapshot.session.status === 'stopped') return;
    const commandId = `stop-${snapshot.session.epoch}`;
    await submitSdkCommand(this.server, {
      contractVersion: 1,
      sessionId: this.params.sessionId,
      epoch: snapshot.session.epoch,
      commandId,
      body: { type: 'session.stop' },
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      const receipt = commandStatusSchema.parse(
        await fetchSdkCommandStatus(this.server, this.params.sessionId, commandId)
      );
      if (receipt.status === 'applied') return;
      if (receipt.status === 'unknown' || receipt.status === 'rejected')
        throw new Error(receipt.message ?? `Stop ${receipt.status}.`);
      await delay(500);
    }
    throw new Error('Stop delivery has not been confirmed. Check the session before retrying.');
  }
}

export async function buildSharedHostConfig(
  session: Pick<Session, 'id' | 'agentId' | 'providerId' | 'agentName' | 'providerSessionId'>,
  params: { sessionPath: string; sessionEnvVars: Record<string, string> },
  transport: LocationTransport,
  intended: { rooms: string[]; startCursor: number }
): Promise<SharedHostConfig> {
  const agent = await getAgentById(session.agentId);
  if (!agent?.switchAgentId) throw new Error('Link the agent to Switch before launching its host.');
  const specialization = (await agentLaunchSpecialization(session.agentId)) ?? {};
  const provider = sharedConfigSchema.shape.start.shape.provider.parse(session.providerId);
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
        reset: false,
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

export async function deploySharedHost(
  transport: LocationTransport,
  sessionPath: string,
  identity: string,
  watcher: boolean
) {
  let ctx: IExecutionContext;
  const bundle = resolveSharedHostBundlePath();
  const hash = createHash('sha256')
    .update(await readFile(bundle))
    .digest('hex');
  const key = createHash('sha256').update(identity).digest('hex');
  let entrypoint = bundle;
  if (transport.kind === 'ssh') {
    const proxy = await ensureSshConnected(transport.connectionId, transport.host);
    ctx = new SshExecutionContext(proxy, { root: sessionPath });
    const { stdout } = await ctx.exec('node', [
      '-e',
      "console.log(require('node:path').join(require('node:os').homedir(),'.local','state','switch','sdk-host'))",
    ]);
    const directory = stdout.trim();
    await ctx.exec('node', [
      '-e',
      "require('node:fs').mkdirSync(process.argv[1],{recursive:true,mode:0o700})",
      directory,
    ]);
    const fs = new SshFileSystem(proxy, directory);
    entrypoint = `${directory}/shared-host-${hash}.mjs`;
    const temporary = `shared-host-${hash}.${randomUUID()}.tmp`;
    await fs.copyLocalFile(bundle, temporary);
    await ctx.exec('node', [
      '-e',
      "require('node:fs').renameSync(process.argv[1],process.argv[2])",
      `${directory}/${temporary}`,
      entrypoint,
    ]);
  } else ctx = new LocalExecutionContext();
  const { stdout } = await ctx.exec('node', [
    '-e',
    "console.log(require('node:path').join(require('node:os').homedir(),'.local','state','switch',process.argv[2],process.argv[1]))",
    key,
    watcher ? 'sdk-watchers' : 'sdk-sessions',
  ]);
  const root = stdout.trim();
  return { ctx, root, entrypoint };
}
