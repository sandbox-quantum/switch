import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXECUTION_INHERIT_ENV } from './agent-env';
import { buildSharedHostConfig } from './build-shared-config';
import {
  executionEnvironment,
  prepareSharedConfig,
  sessionProviderEnvironment,
  sharedConfigSchema,
} from './shared-config';

afterEach(() => vi.unstubAllEnvs());

it('preserves host and configured environment, including shell setup output', async () => {
  vi.stubEnv('SDK_CUSTOM_HOST_VALUE', 'from-host');
  vi.stubEnv('SDK_UNLISTED_VALUE', 'must-not-inherit');
  vi.stubEnv('SWITCH_API_TOKEN', 'discard-inherited-identity');
  const env = await executionEnvironment(
    process.cwd(),
    { SDK_CONFIGURED: 'configured' },
    'echo setup-output; export SDK_CUSTOM_SETUP="$SDK_CONFIGURED-from-setup"',
    ['SDK_CUSTOM_HOST_VALUE', 'PATH', 'HOME', 'SHELL']
  );
  expect(env.SDK_UNLISTED_VALUE).toBeUndefined();
  expect(env.SDK_CUSTOM_HOST_VALUE).toBe('from-host');
  expect(env.SDK_CUSTOM_SETUP).toBe('configured-from-setup');
  expect(env.SWITCH_API_TOKEN).toBeUndefined();
});

it.each([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
])('forwards the provider sign-in variable %s to sessions', (name) => {
  expect(EXECUTION_INHERIT_ENV).toContain(name);
});

it('checks a provider in the environment its sessions get, not the checker’s own', async () => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token');
  vi.stubEnv('SDK_UNLISTED_VALUE', 'must-not-inherit');
  vi.stubEnv('SWITCH_API_TOKEN', 'discard-inherited-identity');
  const probed = await sessionProviderEnvironment(process.cwd());
  expect(probed).toEqual(
    await executionEnvironment(process.cwd(), {}, undefined, [...EXECUTION_INHERIT_ENV])
  );
  expect(probed.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  expect(probed.SDK_UNLISTED_VALUE).toBeUndefined();
  expect(probed.SWITCH_API_TOKEN).toBeUndefined();
});

it('fails before provider startup if shell setup fails', async () => {
  await expect(executionEnvironment(process.cwd(), {}, 'false', [])).rejects.toThrow();
});

it('gives the provider the host’s own MCP server and no Switch identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const config = sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider: 'claude',
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider: 'claude',
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { CONFIGURED: 'yes' },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: { credentialsPath, inheritEnv: [], codexConfig: '', skill: '', context: '' },
    });
    const runtime = {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4321/mcp',
      headers: { Authorization: 'Bearer per-session' },
    };
    const prepared = await prepareSharedConfig(root, config, runtime);
    expect(prepared.input.mcpServers).toEqual({ switch: runtime });
    expect(prepared.input.env).toEqual({ CONFIGURED: 'yes' });
    // The host itself still reports to Switch as the agent.
    expect(prepared).toMatchObject({ agentApiUrl: 'https://switch.test', token: 'agent-token' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('gives Codex the Switch skill as instructions, like the other providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const config = sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider: 'codex',
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider: 'codex',
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { CONFIGURED: 'yes', CODEX_HOME: join(root, 'codex-source') },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: {
        credentialsPath,
        inheritEnv: [],
        codexConfig: '',
        skill: '',
        context: 'Switch skill text',
      },
    });
    const runtime = {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4321/mcp',
      headers: { Authorization: 'Bearer per-session' },
    };
    const prepared = await prepareSharedConfig(root, config, runtime);
    expect(prepared.input.systemContext).toBe('Switch skill text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('the Codex login a session starts with', () => {
  const runtime = { transport: 'http' as const, url: 'http://127.0.0.1:4321/mcp', headers: {} };

  async function codexSession(root: string) {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const sourceHome = join(root, 'codex-source');
    await mkdir(sourceHome);
    await writeFile(join(sourceHome, 'auth.json'), 'first-login');
    const config = buildSharedHostConfig({
      session: { sessionId: 'session', agentId: 'agent', provider: 'codex' },
      launch: {
        cwd: root,
        runtimeMode: 'approval-required',
        env: { CODEX_HOME: sourceHome },
        model: undefined,
      },
      capabilities: { approvals: true, userInput: true },
      execution: {
        credentialsPath,
        inheritEnv: [],
        binaryPath: 'codex',
        codexConfig: '',
        skill: '',
        context: '',
        agentDefinition: undefined,
      },
      ids: { hostId: 'host', epoch: 'epoch', connectionId: 'connection' },
    });
    return { config, sourceHome };
  }

  async function loginAfterReconnect(root: string): Promise<string> {
    const { config, sourceHome } = await codexSession(root);
    await prepareSharedConfig(root, config, runtime);
    await writeFile(join(sourceHome, 'auth.json'), 'reconnected-login');
    const prepared = await prepareSharedConfig(root, config, runtime);
    return readFile(join(prepared.input.env.CODEX_HOME!, 'auth.json'), 'utf8');
  }

  it('keeps its first copy on a host that does not own the login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      expect(await loginAfterReconnect(root)).toBe('first-login');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('follows a reconnected login on a host that asks for it', async () => {
    vi.stubEnv('SWITCH_CODEX_AUTH', 'shared');
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      expect(await loginAfterReconnect(root)).toBe('reconnected-login');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a mode it does not know', async () => {
    vi.stubEnv('SWITCH_CODEX_AUTH', 'sometimes');
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      const { config } = await codexSession(root);
      await expect(prepareSharedConfig(root, config, runtime)).rejects.toThrow('SWITCH_CODEX_AUTH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("gives an agent unit's sessions git and gh through the unit's credentials, over a saved session's", async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'http://127.0.0.1:47100',
          SWITCH_API_TOKEN: 'relay-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
    vi.stubEnv('SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS', credentialsPath);
    vi.stubEnv('SWITCH_HOSTED_GITHUB_REPOSITORY', 'example/project');
    vi.stubEnv('SWITCH_HOSTED_GITHUB_CLI', join(root, 'bin'));
    const config = buildSharedHostConfig({
      session: { sessionId: 'session', agentId: 'agent', provider: 'claude' },
      launch: {
        cwd: root,
        runtimeMode: 'full-access',
        // What a session saved under an earlier host still carries.
        env: {
          SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: '/run/gone/switch.json',
          GIT_CONFIG_VALUE_1: '!stale-helper --git-credential',
        },
        model: undefined,
      },
      capabilities: { approvals: true, userInput: true },
      execution: {
        credentialsPath,
        inheritEnv: [...EXECUTION_INHERIT_ENV],
        binaryPath: 'claude',
        codexConfig: '',
        skill: '',
        context: '',
        agentDefinition: undefined,
      },
      ids: { hostId: 'host', epoch: 'epoch', connectionId: 'connection' },
    });
    const runtime = { transport: 'http' as const, url: 'http://127.0.0.1:4321/mcp', headers: {} };
    const { input } = await prepareSharedConfig(root, config, runtime);
    expect(input.env).toMatchObject({
      SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: credentialsPath,
      SWITCH_HOSTED_GITHUB_REPOSITORY: 'example/project',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_TERMINAL_PROMPT: '0',
      PATH: `${join(root, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    });
    expect(input.env.GIT_CONFIG_VALUE_1).not.toContain('stale-helper');
    expect(input.env.SWITCH_HOSTED_GITHUB_CLI).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('agent definitions in the launch spec', () => {
  const base = (input: Record<string, unknown>, execution: Record<string, unknown> = {}) => ({
    session: {
      sessionId: 'session',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'epoch',
      provider: 'claude',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'claude',
      input: {
        sessionId: 'session',
        cwd: '/repo',
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
        ...input,
      },
    },
    execution: {
      credentialsPath: '/repo/.switch/agents/reviewer.json',
      inheritEnv: [],
      codexConfig: '',
      skill: '',
      context: '',
      ...execution,
    },
  });

  it('carries a definition handed over directly', () => {
    const config = sharedConfigSchema.parse(
      base({
        agentName: 'reviewer',
        agentDefinition: { description: 'Reviews diffs', prompt: 'Be careful.', maxTurns: 3 },
      })
    );
    expect(config.start.input.agentDefinition).toEqual({
      description: 'Reviews diffs',
      prompt: 'Be careful.',
      maxTurns: 3,
    });
  });

  it('still reads a session saved by a Console that named a definition file', () => {
    // Sessions relaunch from the spec they were saved with, so the old shape has
    // to keep parsing after the host is upgraded.
    const config = sharedConfigSchema.parse(
      base({}, { agentDefinition: { name: 'reviewer', path: '.claude/agents/reviewer.md' } })
    );
    expect(config.execution?.agentDefinition).toEqual({
      name: 'reviewer',
      path: '.claude/agents/reviewer.md',
    });
  });

  it('rejects a definition field the SDK would not understand', () => {
    expect(() =>
      sharedConfigSchema.parse(
        base({
          agentName: 'reviewer',
          agentDefinition: { description: 'd', prompt: 'p', color: 'blue' },
        })
      )
    ).toThrow();
  });
});
