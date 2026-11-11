import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acpInitialize } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { createOpenHandsAdapter, openHandsConfiguration, openhandsAcp } from './openhands-acp';

// Avoid LiteLLM's optional model-cost download during an offline smoke test.
const env: Record<string, string> = { LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
for (const name of [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  ...openhandsAcp.inheritEnv!,
]) {
  const value = process.env[name];
  if (value !== undefined) env[name] = value;
}
const probe = spawnSync('openhands', ['acp', '--help'], {
  encoding: 'utf8',
  timeout: 60_000,
  env: { ...env, OPENHANDS_SUPPRESS_BANNER: '1' },
});
const unavailable = probe.error
  ? `openhands acp probe failed (${(probe.error as NodeJS.ErrnoException).code ?? 'unknown'}); install with uv tool install --python 3.12 openhands`
  : probe.status !== 0
    ? `openhands acp --help exited with status ${probe.status}`
    : null;

// This smoke test needs no account and must never send authenticate.
it('real CLI initializes ACP and rejects an unconfigured session without starting login', async (ctx) => {
  if (unavailable) return ctx.skip(unavailable);
  const cwd = await mkdtemp(join(tmpdir(), 'switch-openhands-smoke-'));
  const launch = await openhandsAcp.launch({
    binaryPath: 'openhands',
    cwd,
    env: { ...env, OPENHANDS_PERSISTENCE_DIR: join(cwd, 'profile') },
  });
  const client = new StdioJsonRpcClient({ ...launch, cwd, logger: noopLogger, onExit: () => {} });
  try {
    const initialized = await acpInitialize(client);
    expect(initialized.agentCapabilities).toMatchObject({
      loadSession: true,
      mcpCapabilities: { http: true },
    });
    await expect(client.request('session/new', { cwd, mcpServers: [] })).rejects.toThrow();
  } finally {
    await client.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

it('real CLI persists the configured model and working directory and loads the session after restart', async (ctx) => {
  if (unavailable) return ctx.skip(unavailable);
  const cwd = await mkdtemp(join(tmpdir(), 'switch-openhands-session-'));
  const profile = join(cwd, 'profile');
  const conversations = join(cwd, 'conversations');
  await mkdir(profile);
  // A valid local agent with no tools or credentials. Session initialization
  // and recovery make no LLM calls; prompt conformance still needs an account.
  const model = 'openai/switch-model-probe';
  await writeFile(
    join(profile, 'agent_settings.json'),
    JSON.stringify({
      kind: 'Agent',
      llm: { model, api_key: null },
      tools: [],
    }),
    { mode: 0o600 }
  );
  const sessionEnv = {
    ...env,
    OPENHANDS_PERSISTENCE_DIR: profile,
    OPENHANDS_CONVERSATIONS_DIR: conversations,
  };
  const input = {
    sessionId: 'smoke',
    cwd,
    env: sessionEnv,
    runtimeMode: 'approval-required' as const,
    model: { id: model },
    mcpServers: {},
    connectorMcpServers: [],
  };
  const first = createOpenHandsAdapter();
  const restarted = createOpenHandsAdapter();
  try {
    const session = await first.startSession(input);
    const nativeId = session.nativeSessionId!;
    const stateFile = join(conversations, nativeId.replaceAll('-', ''), 'base_state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(state.agent.llm.model).toBe(model);
    expect(state.workspace.working_dir).toBe(cwd);
    await first.stopAll();
    const resumed = await restarted.startSession({
      ...input,
      resume: { nativeSessionId: nativeId },
    });
    expect(resumed.nativeSessionId).toBe(nativeId);
    expect(await restarted.listModels('smoke')).toMatchObject([{ id: model }]);
    await expect(restarted.setModel('smoke', { id: 'another-model' })).rejects.toThrow(
      'cannot switch'
    );
  } finally {
    await Promise.allSettled([first.stopAll(), restarted.stopAll()]);
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

describeConformance('openhands', {
  createAdapter: async () => createOpenHandsAdapter(),
  unavailableReason: async () => {
    if (unavailable) return unavailable;
    const configuration = await openHandsConfiguration({ cwd: process.cwd(), env });
    return configuration.status === 'authenticated' ? null : configuration.message;
  },
  env,
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'user-input': 'OpenHands 1.16.0 has no ACP structured user-input request (2026-11-04).',
    'mcp-registered':
      'OpenHands 1.16.0 batches permission requests without identifying the MCP server. Switch must ask rather than auto-approve an unidentified tool (2026-11-04).',
  },
});
