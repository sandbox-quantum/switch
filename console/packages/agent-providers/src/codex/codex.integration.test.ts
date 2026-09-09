import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
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
  writeFileSync(join(dir, 'config.toml'), '# Written by the Switch codex conformance suite.\n');
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
