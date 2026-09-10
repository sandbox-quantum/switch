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
import { agentCredsSlug } from '@main/core/agents/agent-creds-slug';
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

const launch = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const [root, entrypoint, encoded, resuming] = process.argv.slice(1);
fs.mkdirSync(root, {recursive:true, mode:0o700});
const config = path.join(root, 'config.json');
let created = false;
if (!fs.existsSync(config)) {
  if (resuming === 'true' && !JSON.parse(Buffer.from(encoded, 'base64').toString()).start.input.resume)
    throw new Error('This session has no saved SDK conversation. It cannot be reopened as a new conversation.');
  const temporary = config + '.' + crypto.randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, Buffer.from(encoded, 'base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temporary, config); created = true; } catch(error) { if (error.code !== 'EEXIST') throw error; }
  fs.unlinkSync(temporary);
}
const owner = path.join(root, 'supervisor', 'owner.json');
try {
  const {pid} = JSON.parse(fs.readFileSync(owner, 'utf8'));
  process.kill(pid, 0);
  console.log(JSON.stringify({created}));
  process.exit(0);
} catch(error) { if (!['ENOENT','ESRCH'].includes(error.code)) throw error; }
const log = fs.openSync(path.join(root, 'supervisor.log'), 'a', 0o600);
const child = spawn(process.execPath, [entrypoint, root, config, '--supervise'], {detached:true, stdio:['ignore',log,log], env:process.env});
child.on('error', error => { throw error; });
child.unref();
fs.closeSync(log);
console.log(JSON.stringify({created}));
`;

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
    const specialization = (await agentLaunchSpecialization(session.agentId)) ?? {};
    const provider = sharedConfigSchema.shape.start.shape.provider.parse(session.providerId);
    const capabilities = providerAdapterRegistry.get(provider).capabilities;
    const slug = agentCredsSlug(session);
    const profile =
      provider === 'codex'
        ? getPlugin(provider).behavior.mcp?.launchProfile?.({
            slug,
            workingDir: this.params.sessionPath,
            values: specialization,
          })
        : undefined;
    const optionKey = provider === 'opencode' ? 'variant' : 'effort';
    const optionValue = specialization[optionKey];
    const intended = switchNotificationPoller.takeSharedIntent(session.id, agent.switchAgentId);
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
          cwd: this.params.sessionPath,
          runtimeMode: agent.autoApprove ? 'full-access' : 'approval-required',
          env: this.params.sessionEnvVars,
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
        credentialsPath: (this.transport.kind === 'ssh' ? posix.join : join)(
          this.params.sessionPath,
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
    let ctx: IExecutionContext;
    const bundle = resolveSharedHostBundlePath();
    const hash = createHash('sha256')
      .update(await readFile(bundle))
      .digest('hex');
    const key = createHash('sha256').update(session.id).digest('hex');
    let entrypoint = bundle;
    if (this.transport.kind === 'ssh') {
      const proxy = await ensureSshConnected(this.transport.connectionId, this.transport.host);
      ctx = new SshExecutionContext(proxy, { root: this.params.sessionPath });
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
      "console.log(require('node:path').join(require('node:os').homedir(),'.local','state','switch','sdk-sessions',process.argv[1]))",
      key,
    ]);
    const root = stdout.trim();
    const launched = await ctx.exec('node', [
      '-e',
      launch,
      root,
      entrypoint,
      Buffer.from(JSON.stringify(config)).toString('base64'),
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
