import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';
import type { McpServerSpec } from '../adapter';
import { describeConformance } from '../testing/index';
import { checkCopilotSignIn, copilotAcp, createCopilotAdapter } from './copilot-adapter';
import { copilotEchoFixture } from './http-echo-fixture';

const mcpServers: Record<string, McpServerSpec> = {};
let echo: Awaited<ReturnType<typeof copilotEchoFixture>> | undefined;
beforeAll(async () => {
  echo = await copilotEchoFixture();
  mcpServers.echo = echo.spec;
});
afterAll(async () => {
  await echo?.close();
});

// Pass only the provider's declared variables plus the harness's basic env.
const env: Record<string, string> = {};
for (const name of [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  ...(copilotAcp.inheritEnv ?? []),
]) {
  const value = process.env[name];
  if (value !== undefined) env[name] = value;
}

describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8', env, timeout: 15_000 });
    if (probe.error || probe.status !== 0) return 'GitHub Copilot CLI is not available on PATH';
    try {
      const result = await checkCopilotSignIn({ binaryPath: 'copilot', cwd: process.cwd(), env });
      return result.status === 'authenticated' ? null : result.message;
    } catch {
      return 'Copilot ACP session access could not be verified; check CLI setup and authentication';
    }
  },
  skip: {
    'user-input':
      'Copilot CLI 1.0.105 (2026-11-04) has no supported ACP structured user-input handler in this integration.',
  },
  mcpServers,
  env,
});
