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
