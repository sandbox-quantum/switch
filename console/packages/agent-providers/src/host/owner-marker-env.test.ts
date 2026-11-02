import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inProcessSupervision } from './launch';
import { OWNER_MARKER_ENV, ownerMarkerSettingsEnv, withOwnerMarker } from './owner-marker-env';
import { SessionLinks } from './session-channel';
import { executionEnvironment, prepareSharedConfig, sharedConfigSchema } from './shared-config';

afterEach(() => vi.unstubAllEnvs());

async function preparedInput(
  env: Record<string, string>,
  mcpServers: Record<string, unknown> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'owner-marker-env-'));
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
          env,
          mcpServers,
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: {
        credentialsPath,
        inheritEnv: ['PATH', OWNER_MARKER_ENV],
        codexConfig: '',
        skill: '',
        context: '',
      },
    });
    const runtime = { transport: 'http' as const, url: 'http://127.0.0.1:4321/mcp', headers: {} };
    return (
      await prepareSharedConfig(
        root,
        config,
        runtime,
        { grants: [], unavailable: null },
        null,
        {},
        () => {}
      )
    ).input;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prepared(env: Record<string, string>) {
  return (await preparedInput(env)).env;
}

describe('a provider CLI started by a host', () => {
  it("carries its host's owner marker, not one its settings plant", async () => {
    vi.stubEnv(OWNER_MARKER_ENV, 'host-marker');
    const env = await prepared({ CONFIGURED: 'yes', [OWNER_MARKER_ENV]: 'planted' });
    expect(env).toMatchObject({ CONFIGURED: 'yes', [OWNER_MARKER_ENV]: 'host-marker' });
  });

  it('carries no marker when its host has none', async () => {
    vi.stubEnv(OWNER_MARKER_ENV, undefined);
    const env = await prepared({ CONFIGURED: 'yes', [OWNER_MARKER_ENV]: 'planted' });
    expect(env).not.toHaveProperty(OWNER_MARKER_ENV);
  });
});

describe('markers an agent could plant elsewhere', () => {
  it("are removed from a configured MCP server's own env, keeping the rest", async () => {
    vi.stubEnv(OWNER_MARKER_ENV, 'host-marker');
    const input = await preparedInput(
      {},
      {
        tool: {
          transport: 'stdio',
          command: 'tool',
          args: [],
          env: { [OWNER_MARKER_ENV]: 'planted', KEEP: '1' },
        },
        web: { transport: 'http', url: 'http://127.0.0.1:9/mcp' },
      }
    );
    expect(input.mcpServers.tool).toMatchObject({ env: { KEEP: '1' } });
    expect((input.mcpServers.tool as { env: Record<string, string> }).env).not.toHaveProperty(
      OWNER_MARKER_ENV
    );
    expect(input.mcpServers.web).toEqual({ transport: 'http', url: 'http://127.0.0.1:9/mcp' });
  });

  it("go to Claude Code's command-line settings, which outrank a settings file", () => {
    expect(ownerMarkerSettingsEnv({ PATH: '/bin', [OWNER_MARKER_ENV]: 'm1' })).toEqual({
      [OWNER_MARKER_ENV]: 'm1',
    });
    expect(ownerMarkerSettingsEnv({ PATH: '/bin' })).toEqual({});
  });
});

describe('withOwnerMarker', () => {
  it("passes on the host's marker, over one the agent's settings name", () => {
    expect(
      withOwnerMarker({ PATH: '/bin', [OWNER_MARKER_ENV]: 'planted' }, { [OWNER_MARKER_ENV]: 'm1' })
    ).toEqual({ PATH: '/bin', [OWNER_MARKER_ENV]: 'm1' });
  });

  it('removes a marker the settings name when the host has none', () => {
    expect(withOwnerMarker({ PATH: '/bin', [OWNER_MARKER_ENV]: 'planted' }, {})).toEqual({
      PATH: '/bin',
    });
    expect(withOwnerMarker({ PATH: '/bin' }, { [OWNER_MARKER_ENV]: '' })).toEqual({ PATH: '/bin' });
  });

  it('is needed: the CLI environment leaves every SWITCH_ variable of the host out', async () => {
    const before = process.env[OWNER_MARKER_ENV];
    process.env[OWNER_MARKER_ENV] = 'm1';
    try {
      const inherited = await executionEnvironment(process.cwd(), {}, undefined, [
        'PATH',
        OWNER_MARKER_ENV,
      ]);
      expect(inherited[OWNER_MARKER_ENV]).toBeUndefined();
      expect(withOwnerMarker(inherited, process.env)[OWNER_MARKER_ENV]).toBe('m1');
    } finally {
      if (before === undefined) delete process.env[OWNER_MARKER_ENV];
      else process.env[OWNER_MARKER_ENV] = before;
    }
  });
});

describe('a session host supervised in-process (an agent with no login)', () => {
  it("starts with its agent's marker, leaving this process's environment alone", async () => {
    const root = await mkdtemp(join(tmpdir(), 'owner-marker-inprocess-'));
    const entrypoint = join(root, 'host.cjs');
    await writeFile(
      entrypoint,
      `require('node:fs').writeFileSync(process.argv[2] + '/marker', process.env.${OWNER_MARKER_ENV} ?? 'none');
       process.on('message', (m) => { if (m && m.kind === 'switch-stop') process.exit(0); });
       setInterval(() => {}, 1000);`
    );
    const supervision = inProcessSupervision(entrypoint, new SessionLinks(), {
      [OWNER_MARKER_ENV]: 'agent-marker',
    });
    try {
      await supervision.start({ root, configPath: join(root, 'config.json'), watcher: false });
      const marker = await vi.waitFor(async () => await readFile(join(root, 'marker'), 'utf8'), {
        timeout: 10000,
      });
      expect(marker).toBe('agent-marker');
      expect(process.env[OWNER_MARKER_ENV]).toBeUndefined();
    } finally {
      await supervision.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
