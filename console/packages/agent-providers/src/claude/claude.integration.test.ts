import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createClaudeAdapter, resolveClaudeExecutable } from './claude-adapter';

const run = promisify(execFile);

function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * `claude auth status` prints the account's own details, so only the
 * `loggedIn` flag is ever read out of it.
 */
async function unavailableReason(): Promise<string | null> {
  const executable = resolveClaudeExecutable(undefined, currentEnv());
  if (!executable) return 'no `claude` executable on PATH';
  try {
    const { stdout } = await run(executable, ['auth', 'status'], { timeout: 30_000 });
    const status: unknown = JSON.parse(stdout);
    const loggedIn =
      typeof status === 'object' && status !== null && 'loggedIn' in status
        ? status.loggedIn
        : false;
    return loggedIn === true ? null : 'claude is not logged in';
  } catch (cause) {
    return `claude auth status failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

describeConformance('claude', {
  createAdapter: async () => createClaudeAdapter(),
  unavailableReason,
  model: { id: 'claude-sonnet-5' },
  mcpServers: { switch_echo: echoMcpServerSpec() },
});
