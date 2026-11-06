import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { configuredModel, createOpenhandsAdapter } from './openhands-acp';

const profileEnv: Record<string, string> = { LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
for (const key of ['OPENHANDS_PERSISTENCE_DIR', 'OPENHANDS_CONVERSATIONS_DIR']) {
  if (process.env[key]) profileEnv[key] = process.env[key];
}
const bridge = {
  transport: 'stdio' as const,
  command: process.execPath,
  args: [
    fileURLToPath(new URL('../../dist/shared-host-daemon.mjs', import.meta.url)),
    '--openhands-mcp',
  ],
};
const version = spawnSync('openhands', ['--version'], {
  encoding: 'utf8',
  timeout: 20_000,
  env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True', OPENHANDS_SUPPRESS_BANNER: '1' },
});
const cliAvailable = !version.error && version.status === 0;

describeConformance('openhands', {
  createAdapter: async () => createOpenhandsAdapter({ mcpBridge: bridge }),
  unavailableReason: async () => {
    if (!cliAvailable) return 'OpenHands CLI is not installed or its version probe failed';
    try {
      return (await configuredModel(profileEnv))
        ? null
        : 'OpenHands has no configured model; run openhands on the execution machine first';
    } catch {
      return 'OpenHands settings cannot be read';
    }
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env: profileEnv,
  timeoutMs: 300_000,
  skip: {
    'user-input': 'OpenHands CLI 1.16.0 exposes permission requests, but no ACP question tool.',
    'mcp-registered':
      'OpenHands asks for a whole step and does not identify the MCP server; Switch cannot exempt registered tools from that approval.',
  },
});

it('starts and resumes the real CLI with the selected model and working directory, without an inference call', async (ctx) => {
  if (!cliAvailable) return ctx.skip('OpenHands CLI is not installed');
  const directory = await mkdtemp(join(tmpdir(), 'switch-openhands-smoke-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const model = 'openai/gpt-4o-mini';
  await writeFile(
    join(directory, 'agent_settings.json'),
    JSON.stringify({ llm: { model, api_key: null }, tools: [] })
  );
  const env: Record<string, string> = {
    OPENHANDS_PERSISTENCE_DIR: directory,
    OPENHANDS_CONVERSATIONS_DIR: join(directory, 'conversations'),
    LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  };
  env.HOME = directory;
  for (const key of ['PATH', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  const first = createOpenhandsAdapter({ mcpBridge: bridge });
  const second = createOpenhandsAdapter({ mcpBridge: bridge });
  const input = {
    cwd: workspace,
    runtimeMode: 'approval-required' as const,
    env,
    model: { id: model },
    mcpServers: { echo: echoMcpServerSpec() },
    connectorMcpServers: [],
  };
  try {
    const catalogue = spawnSync(
      process.execPath,
      [bridge.args[0]!, '--models', 'openhands', workspace, 'missing-openhands-fixture-binary'],
      { encoding: 'utf8', env, timeout: 20_000 }
    );
    expect(catalogue.status).toBe(0);
    expect(JSON.parse(catalogue.stdout).models).toEqual([{ id: model, name: model }]);
    const session = await first.startSession({ ...input, sessionId: 'before-restart' });
    expect(await first.listModels('before-restart')).toMatchObject([{ id: model }]);
    await first.stopAll();
    const statePath = join(
      env.OPENHANDS_CONVERSATIONS_DIR!,
      session.nativeSessionId.replaceAll('-', ''),
      'base_state.json'
    );
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
      agent: { llm: { model: string } };
      workspace: { working_dir: string };
    };
    expect(saved.agent.llm.model).toBe(model);
    expect(saved.workspace.working_dir).toBe(await realpath(workspace));
    const restored = await second.startSession({
      ...input,
      sessionId: 'after-restart',
      resume: { nativeSessionId: session.nativeSessionId },
    });
    expect(restored.nativeSessionId).toBe(session.nativeSessionId);
  } finally {
    await Promise.all([first.stopAll(), second.stopAll()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
