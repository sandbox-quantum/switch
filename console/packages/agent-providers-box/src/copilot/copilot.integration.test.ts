import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime-box/hosted';
import { afterAll } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance } from '../testing/index';
import { copilotAcp, createCopilotAdapter } from './copilot-acp';

// Copilot CLI takes only HTTP and SSE MCP servers from an ACP client, and
// drops a stdio one with a warning in its log ("Rejecting non-http/sse MCP
// server"). So the echo tool is served over HTTP, the way Switch serves its own.
const token = randomBytes(32).toString('hex');
const echo = await serveMcpOverHttp(token, {
  listTools: async () => [
    {
      name: 'switch_echo',
      description: 'Echoes the given text back. Used by Switch conformance tests.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
  callTool: async (_name, args) => ({ content: [{ type: 'text', text: String(args.text ?? '') }] }),
});
afterAll(() => echo.close());

// The suite hands the CLI a minimal environment, so Copilot's own variables
// (a GitHub token, a custom model provider) are passed through as a session
// host would pass them.
const env = Object.fromEntries(
  (copilotAcp.inheritEnv ?? []).flatMap((name) => {
    const value = process.env[name];
    return value ? [[name, value]] : [];
  })
);

describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the copilot binary is not on PATH';
    const signIn = await checkAcpSignIn(copilotAcp, {
      binaryPath: 'copilot',
      cwd: tmpdir(),
      env: { HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  },
  skip: {
    'user-input':
      'Copilot CLI 1.0.105 gives the model no question tool over ACP: ask_user is not among the tools it sends, whether or not the client declares elicitation (2026-11-05).',
  },
  mcpServers: {
    echo: { transport: 'http', url: echo.url, headers: { Authorization: `Bearer ${token}` } },
  },
  env,
});
