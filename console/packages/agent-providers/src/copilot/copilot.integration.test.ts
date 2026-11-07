import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import { afterAll } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance } from '../testing/index';
import { copilotAcp, createCopilotAdapter } from './copilot-acp';

// The harness hands the CLI a minimal environment, so a token, a Copilot home
// or a bring-your-own-key provider in the shell would not reach it otherwise.
const env = Object.fromEntries(
  [...(copilotAcp.inheritEnv ?? []), 'GH_TOKEN', 'GITHUB_TOKEN'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

// Copilot's ACP server takes MCP servers over HTTP or SSE only: it declares
// `mcpCapabilities: { http, sse }` and drops a stdio server from `session/new`
// with nothing but a log line ("Rejecting non-http/sse MCP server"). Switch
// serves its own tools and every connector over HTTP, so the echo tool is
// served that way here too, rather than as the stdio fixture.
const token = randomBytes(32).toString('hex');
const echo = await serveMcpOverHttp(token, {
  listTools: async () => [
    {
      name: 'switch_echo',
      description: 'Echoes the given text back. Used by Switch conformance tests.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
  callTool: async (_name, args) => ({
    content: [{ type: 'text', text: String((args as { text?: unknown }).text ?? '') }],
  }),
});
afterAll(() => echo.close());

describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the copilot binary is not on PATH';
    const signIn = await checkAcpSignIn(copilotAcp, {
      binaryPath: 'copilot',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Copilot CLI is not signed in (run copilot login, or set COPILOT_GITHUB_TOKEN to a token with the Copilot Requests permission)';
  },
  timeoutMs: 300_000,
  mcpServers: {
    echo: { transport: 'http', url: echo.url, headers: { Authorization: `Bearer ${token}` } },
  },
  env,
});
