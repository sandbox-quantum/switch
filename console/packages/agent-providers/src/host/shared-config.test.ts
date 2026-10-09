import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executionEnvironment,
  prepareSharedConfig,
  sessionServiceGrants,
  servicesUnavailableNotice,
  sharedConfigSchema,
} from './shared-config';

const NO_SERVICES = { grants: [], unavailable: null };

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
    const prepared = await prepareSharedConfig(root, config, runtime, NO_SERVICES, null, {});
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
    const prepared = await prepareSharedConfig(root, config, runtime, NO_SERVICES, null, {});
    expect(prepared.input.systemContext).toBe('Switch skill text');
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

describe('the skills of the agent’s service grants', () => {
  const GITHUB_SKILL = {
    name: 'github',
    content: '---\nname: github\ndescription: d\n---\n\n# GitHub\n\nUse gh.\n',
  };
  const GITHUB_GRANT = {
    service: 'github',
    access: 'read' as const,
    tool_mode: 'allow' as const,
    tools: [],
    resources: {},
    skill: GITHUB_SKILL,
    mcp_servers: [],
    cli_tools: [],
  };
  const runtime = {
    transport: 'http' as const,
    url: 'http://127.0.0.1:4321/mcp',
    headers: { Authorization: 'Bearer per-session' },
  };

  async function configFor(root: string, provider: 'claude' | 'opencode') {
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
    return sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider,
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
        provider,
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: {},
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
  }

  afterEach(() => vi.unstubAllGlobals());

  it('join the context, except for OpenCode, which loads them as files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      const claude = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        { grants: [GITHUB_GRANT], unavailable: null },
        null,
        {}
      );
      expect(claude.input.systemContext).toBe('Switch skill text\n\n# GitHub\n\nUse gh.');
      const opencode = await prepareSharedConfig(
        root,
        await configFor(root, 'opencode'),
        runtime,
        { grants: [GITHUB_GRANT], unavailable: null },
        null,
        {}
      );
      expect(opencode.input.systemContext).toBe('Switch skill text');
      // Without a service endpoint nothing is set up for GitHub.
      expect(claude.input.env.SWITCH_SERVICE_ENDPOINT).toBeUndefined();
      expect(claude.input.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('give the CLI each granted vendor’s server under its own name, beside Switch’s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    const vendor = {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4322/mcp',
      headers: { Authorization: 'Bearer per-session-vendor' },
    };
    try {
      const prepared = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        NO_SERVICES,
        null,
        { example: vendor }
      );
      expect(prepared.input.mcpServers).toEqual({ example: vendor, switch: runtime });
      await expect(
        prepareSharedConfig(root, await configFor(root, 'claude'), runtime, NO_SERVICES, null, {
          switch: vendor,
        })
      ).rejects.toThrow('which is taken');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tell the session when they could not be loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      for (const provider of ['claude', 'opencode'] as const) {
        const prepared = await prepareSharedConfig(
          root,
          await configFor(root, provider),
          runtime,
          { grants: [], unavailable: 'Switch refused (HTTP 503).' },
          null,
          {}
        );
        expect(prepared.input.systemContext).toBe(
          `Switch skill text\n\n${servicesUnavailableNotice('Switch refused (HTTP 503).')}`
        );
      }
      expect(servicesUnavailableNotice('Switch refused (HTTP 503).')).toContain(
        'could not load the services granted to this agent'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('set up the (refusing) GitHub helpers when they could not be loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      const prepared = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        { grants: [], unavailable: 'Switch refused (HTTP 503).' },
        {
          endpoint: { url: 'http://127.0.0.1:5555', token: 'per-session-bearer' },
          execPath: '/usr/bin/node',
          entrypoint: '/opt/switch/shared-host.mjs',
        },
        {}
      );
      // Git and gh ask the endpoint, which refuses, rather than this machine's sign-in.
      expect(prepared.input.env.SWITCH_SERVICE_ENDPOINT).toBe('http://127.0.0.1:5555');
      expect(prepared.input.env.GIT_CONFIG_PARAMETERS).toContain(
        'credential.https://github.com.helper=!'
      );
      expect(await readFile(join(root, 'bin', 'gh'), 'utf8')).toContain('--github-cli');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('set up GitHub for a session with a service endpoint and a GitHub grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    // The machine's own helper, which follows Switch's for when it gives no token.
    await writeFile(join(root, '.gitconfig'), '[credential]\n\thelper = machine-own\n');
    vi.stubEnv('HOME', root);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, '.gitconfig'));
    try {
      const prepared = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        { grants: [GITHUB_GRANT], unavailable: null },
        {
          endpoint: { url: 'http://127.0.0.1:5555', token: 'per-session-bearer' },
          execPath: '/usr/bin/node',
          entrypoint: '/opt/switch/shared-host.mjs',
        },
        {}
      );
      const env = prepared.input.env;
      expect(env.SWITCH_SERVICE_ENDPOINT).toBe('http://127.0.0.1:5555');
      expect(env.SWITCH_SERVICE_BEARER).toBe('per-session-bearer');
      expect(env.GIT_CONFIG_PARAMETERS).toContain(
        "/opt/switch/shared-host.mjs'\\'' --git-credential"
      );
      expect(env.GIT_CONFIG_PARAMETERS).toContain(
        "'credential.https://github.com.useHttpPath=true'"
      );
      expect(JSON.parse(env.SWITCH_GITHUB_FALLBACK ?? '{}')).toEqual({
        helpers: ['machine-own'],
        wrapper: join(root, 'bin'),
      });
      expect(env.PATH?.split(':')[0]).toBe(join(root, 'bin'));
      expect(await readFile(join(root, 'bin', 'gh'), 'utf8')).toContain('--github-cli');
      // The helpers ask for GitHub's token; none is in the session's environment.
      expect(env.GH_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('are read as the session starts, and a session starts without them when they cannot be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = await configFor(root, 'claude');
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grants: [GITHUB_GRANT],
            })
          )
      );
      vi.stubGlobal('fetch', fetchMock);
      expect(await sessionServiceGrants(config)).toEqual({
        grants: [GITHUB_GRANT],
        unavailable: null,
      });
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'https://switch.test/agents/agent/service-grants'
      );

      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }))
      );
      expect(await sessionServiceGrants(config)).toEqual({
        grants: [],
        unavailable: "Switch refused this agent's service grants (HTTP 503).",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
