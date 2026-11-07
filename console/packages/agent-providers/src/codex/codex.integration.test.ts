import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EventRecorder, describeConformance, echoMcpServerSpec } from '../testing/index';
import { createCodexAdapter } from './codex-adapter';

const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_AUTH = join(USER_CODEX_HOME, 'auth.json');

/**
 * A throwaway `CODEX_HOME` so the suite never reads the developer's own
 * `config.toml` (MCP servers, hooks, model pins). The login lives in
 * `auth.json` and is the only thing copied across.
 */
function isolatedCodexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'switch-codex-home-'));
  if (existsSync(USER_AUTH)) copyFileSync(USER_AUTH, join(dir, 'auth.json'));
  writeFileSync(join(dir, 'config.toml'), 'sandbox_mode = "workspace-write"\n');
  return dir;
}

const codexHome = isolatedCodexHome();

describeConformance('codex', {
  createAdapter: async () => createCodexAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the codex binary is not on PATH';
    if (!existsSync(join(codexHome, 'auth.json'))) {
      return `no codex login found at ${USER_AUTH}; run \`codex login\``;
    }
    return null;
  },
  env: { CODEX_HOME: codexHome },
  mcpServers: { switch_echo: echoMcpServerSpec() },
  skip: {
    'user-input':
      'codex-cli 0.153.2 refuses the tool outside Plan mode: `codex_core::tools::router error=request_user_input is unavailable in Default mode`. The adapter still maps `item/tool/requestUserInput` and answers it; only the model cannot reach the tool in the mode Switch sessions run in.',
  },
});

it.skipIf(!existsSync(USER_AUTH) || spawnSync('codex', ['--version']).status !== 0)(
  'confirms a Codex correction joins the running turn',
  async () => {
    const adapter = createCodexAdapter();
    const recorder = new EventRecorder(adapter);
    const cwd = mkdtempSync(join(tmpdir(), 'switch-steering-proof-'));
    const sessionId = `steering-${Date.now()}`;
    const env: Record<string, string> = { CODEX_HOME: codexHome };
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'])
      if (process.env[key]) env[key] = process.env[key]!;
    try {
      await adapter.startSession({
        sessionId,
        cwd,
        runtimeMode: 'full-access',
        env,
        mcpServers: {},
        connectorMcpServers: [],
      });
      await adapter.sendTurn({
        sessionId,
        turnId: 'working',
        text: 'Count from 1 to 2000, one number per line. Do not use tools.',
      });
      await recorder.waitFor('turn.started', (event) => event.turnId === 'working', 30_000);
      const result = await adapter.sendTurn({
        sessionId,
        turnId: 'correction',
        text: 'Stop counting. Reply with exactly SWITCH_STEERING_CONFIRMED.',
      });
      expect(result.steeredInto).toBe('working');
      await recorder.waitFor(
        'turn.completed',
        (event) => event.turnId === 'working' && event.outcome === 'completed',
        150_000
      );
      expect(recorder.assistantText('working')).toContain('SWITCH_STEERING_CONFIRMED');
    } finally {
      await adapter.stopAll();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  180_000
);
