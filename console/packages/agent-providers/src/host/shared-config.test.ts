import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexHomeNotAbsolute } from '../codex/home';
import { PI_SDK_ENV } from '../pi/sdk-env';
import { providerRuntime, providerRuntimeIds } from '../providers/registry';
import { AGENT_ENV_VARS, EXECUTION_INHERIT_ENV } from './agent-env';
import { withDefinitionOf } from './agent-host';
import {
  executionEnvironment,
  prepareSharedConfig,
  sessionServiceGrants,
  servicesUnavailableNotice,
  sharedConfigSchema,
} from './shared-config';

const NO_SERVICES = { grants: [], unavailable: null };
const NO_REDACTIONS = () => {};

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === 'win32')(
  'preserves host and configured environment, including shell setup output',
  async () => {
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
  }
);

it('fails before provider startup if shell setup fails', async () => {
  await expect(executionEnvironment(process.cwd(), {}, 'false', [])).rejects.toThrow();
});

it.runIf(process.platform === 'win32')('refuses shell setup on Windows, saying why', async () => {
  await expect(executionEnvironment(process.cwd(), {}, 'echo hi', [])).rejects.toThrow(
    /POSIX shell snippet/
  );
});

it('inherits Path whatever its case on Windows', async () => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.stubEnv('Path', 'C:\\Windows\\System32');
  try {
    const env = await executionEnvironment(process.cwd(), {}, undefined, ['PATH']);
    // Windows has one variable whatever its case; the key is the case it was first set in.
    const key = Object.keys(env).find(
      (name) => name.toUpperCase() === 'PATH' && env[name] === 'C:\\Windows\\System32'
    );
    expect(key).toBeDefined();
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
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
    const prepared = await prepareSharedConfig(
      root,
      config,
      runtime,
      NO_SERVICES,
      null,
      {},
      NO_REDACTIONS
    );
    expect(prepared.input.mcpServers).toEqual({ switch: runtime });
    expect(prepared.input.env).toEqual({ CONFIGURED: 'yes' });
    // The host itself still reports to Switch as the agent.
    expect(prepared).toMatchObject({ agentApiUrl: 'https://switch.test', token: 'agent-token' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A Codex session's launch spec, taking its Codex home from `CODEX_HOME`. */
async function codexHostConfig(root: string) {
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
}

const CODEX_RUNTIME = {
  transport: 'http' as const,
  url: 'http://127.0.0.1:4321/mcp',
  headers: { Authorization: 'Bearer per-session' },
};

it('gives Codex the Switch skill as instructions, like the other providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const config = await codexHostConfig(root);
    const prepared = await prepareSharedConfig(
      root,
      config,
      CODEX_RUNTIME,
      NO_SERVICES,
      null,
      {},
      NO_REDACTIONS
    );
    expect(prepared.input.systemContext).toBe('Switch skill text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses to start a Codex session whose CODEX_HOME is relative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const config = await codexHostConfig(root);
    config.start.input.env.CODEX_HOME = 'codex-source';
    await expect(
      prepareSharedConfig(root, config, CODEX_RUNTIME, NO_SERVICES, null, {}, NO_REDACTIONS)
    ).rejects.toThrow(codexHomeNotAbsolute('codex-source'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('hands a Codex session the keyring login of a home with no auth.json, with only what reading it needs', async () => {
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus');
  vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000');
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const source = join(root, 'codex-source');
    const config = await codexHostConfig(root);
    Object.assign(config.start.input.env, { PATH: '/usr/bin', OPENAI_API_KEY: 'session-only' });
    const redact = vi.fn();
    const keyring = await prepareSharedConfig(
      root,
      config,
      CODEX_RUNTIME,
      NO_SERVICES,
      null,
      {},
      redact
    );
    const login = keyring.input.codexKeyringLogin;
    expect(login?.home).toBe(source);
    expect(login?.env).toEqual({
      PATH: '/usr/bin',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    login?.redact('fixture-secret');
    expect(redact).toHaveBeenCalledWith('fixture-secret');
    expect(keyring.input.env.CODEX_HOME).not.toBe(source);
    expect(keyring.input.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();

    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'auth.json'), '{"fixture":"login"}');
    const file = await prepareSharedConfig(
      root,
      await codexHostConfig(root),
      CODEX_RUNTIME,
      NO_SERVICES,
      null,
      {},
      NO_REDACTIONS
    );
    expect(file.input.codexKeyringLogin).toBeUndefined();
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
        {},
        NO_REDACTIONS
      );
      expect(claude.input.systemContext).toBe('Switch skill text\n\n# GitHub\n\nUse gh.');
      const opencode = await prepareSharedConfig(
        root,
        await configFor(root, 'opencode'),
        runtime,
        { grants: [GITHUB_GRANT], unavailable: null },
        null,
        {},
        NO_REDACTIONS
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
        { example: vendor },
        NO_REDACTIONS
      );
      expect(prepared.input.mcpServers).toEqual({ example: vendor, switch: runtime });
      await expect(
        prepareSharedConfig(
          root,
          await configFor(root, 'claude'),
          runtime,
          NO_SERVICES,
          null,
          {
            switch: vendor,
          },
          NO_REDACTIONS
        )
      ).rejects.toThrow('which is taken');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('name the granted vendors, MCP and CLI alike, as the connectors, never Switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    const served = (port: number) => ({
      transport: 'http' as const,
      url: `http://127.0.0.1:${port}/mcp`,
    });
    try {
      const prepared = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        NO_SERVICES,
        null,
        // A vendor MCP server and a vendor CLI, both served on loopback.
        { atlassian: served(4400), 'google-workspace': served(4401) },
        NO_REDACTIONS
      );
      expect(prepared.input.connectorMcpServers.sort()).toEqual(['atlassian', 'google-workspace']);
      expect(prepared.input.connectorMcpServers).not.toContain('switch');
      expect(Object.keys(prepared.input.mcpServers).sort()).toEqual([
        'atlassian',
        'google-workspace',
        'switch',
      ]);
      const none = await prepareSharedConfig(
        root,
        await configFor(root, 'claude'),
        runtime,
        NO_SERVICES,
        null,
        {},
        NO_REDACTIONS
      );
      expect(none.input.connectorMcpServers).toEqual([]);
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
          {},
          NO_REDACTIONS
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
        {},
        NO_REDACTIONS
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

  it.skipIf(process.platform === 'win32')(
    'set up GitHub for a session with a service endpoint and a GitHub grant',
    async () => {
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
          {},
          NO_REDACTIONS
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
    }
  );

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

describe('a provider runtime’s own variables', () => {
  /**
   * The environment a session of `provider` starts with, launched with
   * `EXECUTION_INHERIT_ENV` as Console and the controller launch one. Given
   * `saved`, the session is one saved with that list instead and started
   * again under such a launch's template (`withDefinitionOf`), as a resumed,
   * retried or restarted session is.
   */
  async function sessionEnv(
    provider: string,
    saved?: readonly string[]
  ): Promise<Record<string, string>> {
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
      const configWith = (inheritEnv: readonly string[]) =>
        sharedConfigSchema.parse({
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
              env: provider === 'codex' ? { CODEX_HOME: join(root, 'codex-source') } : {},
              mcpServers: {},
            },
          },
          roomConnection: { connectionId: 'controller' },
          execution: {
            credentialsPath,
            inheritEnv: [...inheritEnv],
            codexConfig: '',
            skill: '',
            context: '',
          },
        });
      const template = configWith(EXECUTION_INHERIT_ENV);
      const config = saved ? withDefinitionOf(configWith(saved), template) : template;
      const prepared = await prepareSharedConfig(
        root,
        config,
        CODEX_RUNTIME,
        NO_SERVICES,
        null,
        {},
        NO_REDACTIONS
      );
      return prepared.input.env;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /**
   * Read only by Pi: a key, Azure's endpoint, what AWS's role, container and
   * file credentials need beside their own variable, the operator's shutting
   * of the instance metadata service to AWS's SDK, and its endpoint. And every
   * other variable of credentials, an endpoint or a region that the SDKs Pi
   * uses read (`PI_SDK_ENV`), none of them shared before.
   */
  const PI_ONLY: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(PI_SDK_ENV)
        .filter(
          ([name, { decision }]) => decision === 'pi' && !EXECUTION_INHERIT_ENV.includes(name)
        )
        .map(([name]) => [name, `fake-${name.toLowerCase()}`])
    ),
    AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://[fd00:ec2::254]',
    AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: 'IPv6',
    DEEPSEEK_API_KEY: 'fake-deepseek',
    AZURE_OPENAI_RESOURCE_NAME: 'fake-resource',
    AZURE_OPENAI_BASE_URL: 'https://fake.example',
    AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/fake',
    AWS_ROLE_SESSION_NAME: 'fake-session',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: 'fake-container-token',
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/fake/container-token',
    AWS_CONFIG_FILE: '/fake/aws-config',
    AWS_SHARED_CREDENTIALS_FILE: '/fake/aws-credentials',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
  };
  /** Given to every provider's sessions before Pi. */
  const SHARED = { OPENROUTER_API_KEY: 'fake-openrouter', OPENAI_API_KEY: 'fake-openai' };

  function stubAll(): void {
    for (const [name, value] of Object.entries({ ...PI_ONLY, ...SHARED })) vi.stubEnv(name, value);
  }

  const others = () => providerRuntimeIds().filter((id) => id !== 'pi');

  it('reach that provider’s sessions only, and every variable shared before still reaches all', async () => {
    stubAll();
    expect(others()).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'cursor']);
    for (const provider of others()) {
      const env = await sessionEnv(provider);
      for (const name of Object.keys(PI_ONLY))
        expect(env[name], `${provider}: ${name}`).toBeUndefined();
      expect(env, provider).toMatchObject(SHARED);
    }
    expect(await sessionEnv('pi')).toMatchObject({ ...PI_ONLY, ...SHARED });
  });

  it('reach that provider’s sessions only when a session saved with a wider list is started again', async () => {
    stubAll();
    // What every session was saved with while the list every session is
    // launched with also held each provider's own variables.
    const wider = [
      ...EXECUTION_INHERIT_ENV,
      ...providerRuntimeIds().flatMap((id) => providerRuntime(id).inheritEnv),
    ];
    for (const name of Object.keys(PI_ONLY)) expect(wider).toContain(name);
    for (const provider of others()) {
      const env = await sessionEnv(provider, wider);
      for (const name of Object.keys(PI_ONLY))
        expect(env[name], `${provider}: ${name}`).toBeUndefined();
      expect(env, provider).toMatchObject(SHARED);
    }
    expect(await sessionEnv('pi', wider)).toMatchObject({ ...PI_ONLY, ...SHARED });
  });

  it('leave a session saved with the list every session is launched with as it was', async () => {
    stubAll();
    for (const provider of providerRuntimeIds())
      expect(
        Object.keys(await sessionEnv(provider, EXECUTION_INHERIT_ENV)).sort(),
        provider
      ).toEqual(Object.keys(await sessionEnv(provider)).sort());
  });

  it('are not in the list every session is launched with, which holds what it held before', () => {
    const shared = new Set<string>(AGENT_ENV_VARS);
    for (const id of providerRuntimeIds())
      for (const name of providerRuntime(id).inheritEnv)
        if (!shared.has(name)) expect(EXECUTION_INHERIT_ENV, `${id}: ${name}`).not.toContain(name);
    for (const name of AGENT_ENV_VARS) expect(EXECUTION_INHERIT_ENV).toContain(name);
    // As it was before Pi (`f4e039948`), in its order.
    expect(EXECUTION_INHERIT_ENV).toEqual([
      'ALL_PROXY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_VERTEX_BASE_URL',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'AWS_ACCESS_KEY_ID',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_DEFAULT_REGION',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_OPENAI_API_ENDPOINT',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_KEY',
      'BAILIAN_CODING_PLAN_API_KEY',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CONFIG_DIR',
      'CLOUDSDK_CONFIG',
      'CLOUD_ML_REGION',
      'CODEX_HOME',
      'CURSOR_API_KEY',
      'DASHSCOPE_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_GEMINI_BASE_URL',
      'GOOGLE_GENAI_API_VERSION',
      'GOOGLE_VERTEX_BASE_URL',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'KIMI_API_KEY',
      'MISTRAL_API_KEY',
      'MOONSHOT_API_KEY',
      'NO_PROXY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'OPENCODE_MODEL',
      'OPENROUTER_API_KEY',
      'OPENROUTER_BASE_URL',
      'XAI_API_KEY',
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'TMPDIR',
      'LANG',
      'TERM',
      'SSH_AUTH_SOCK',
      'APPDATA',
      'COMSPEC',
      'COMMONPROGRAMFILES',
      'HOMEDRIVE',
      'HOMEPATH',
      'LOCALAPPDATA',
      'NUMBER_OF_PROCESSORS',
      'OS',
      'PATHEXT',
      'PROCESSOR_ARCHITECTURE',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ]);
  });
});
