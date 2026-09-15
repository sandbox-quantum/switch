import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, afterEach } from 'vitest';
import { executionEnvironment, prepareSharedConfig, sharedConfigSchema } from './shared-config';

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

it('pins a room session to its room and leaves a roaming session unpinned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'http://127.0.0.1/agent',
          SWITCH_API_TOKEN: 'token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const config = sharedConfigSchema.parse({
      session: {
        sessionId: 'session-a',
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
          sessionId: 'session-a',
          cwd: root,
          runtimeMode: 'approval-required',
          env: {},
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'connection-a', rooms: ['room-a'], startCursor: 0 },
      execution: {
        credentialsPath,
        inheritEnv: [],
        mcpRuntime: '@example/runtime',
        codexConfig: '',
        skill: '',
        context: '',
      },
    });

    const forwarded = (prepared: Awaited<ReturnType<typeof prepareSharedConfig>>) => {
      const server = prepared.input.mcpServers.switch;
      if (server?.transport !== 'stdio') throw new Error('The Switch MCP server is not stdio.');
      return server.envVars ?? [];
    };

    const pinned = await prepareSharedConfig(root, config, 'room-a');
    expect(pinned.input.env.SWITCH_BOUND_ROOM_ID).toBe('room-a');
    // The pin travels to the Switch tools by name, like the rest of the identity.
    expect(forwarded(pinned)).toContain('SWITCH_BOUND_ROOM_ID');

    // A session that may move between rooms carries no pin at all.
    const roaming = await prepareSharedConfig(root, config, null);
    expect(roaming.input.env.SWITCH_BOUND_ROOM_ID).toBeUndefined();
    expect(forwarded(roaming)).not.toContain('SWITCH_BOUND_ROOM_ID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
