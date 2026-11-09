import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import { afterAll } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance } from '../testing/index';
import { clineAcp, createClineAdapter } from './cline-adapter';

const BINARY = process.env['SWITCH_CLINE_BIN'] ?? 'cline';
// The harness hands the CLI a minimal environment, so Cline's own variables
// would not reach it and a key-based sign-in would read as signed out.
const ENV = Object.fromEntries(
  ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_DIR', 'USERPROFILE']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name] as string])
);

// The echo tool over HTTP with a bearer token, as Switch serves a session's
// tools. Cline 3.0.74 did not start a stdio server from its settings in ACP
// mode, and Switch gives a session none.
const token = randomBytes(32).toString('hex');
const echo = await serveMcpOverHttp(token, {
  listTools: async () => [
    {
      name: 'switch_echo',
      description: 'Echoes the given text back. Used by Switch conformance tests.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
  callTool: async (_name, args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
});
afterAll(() => echo.close());

describeConformance('cline', {
  createAdapter: async () => createClineAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    try {
      const signIn = await checkAcpSignIn(clineAcp, {
        binaryPath: BINARY,
        cwd: homedir(),
        env: { ...(process.env as Record<string, string>), ...ENV },
      });
      return signIn.status === 'authenticated' ? null : signIn.message;
    } catch (error) {
      return `\`${BINARY} --acp\` failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  ...(process.env['SWITCH_CLINE_MODEL']
    ? { model: { id: process.env['SWITCH_CLINE_MODEL'] } }
    : {}),
  env: ENV,
  skip: {
    'user-input':
      'cline 3.0.74 has no question tool over ACP: its ACP sessions are built without the askQuestion executor its terminal modes pass, so ask_question is not offered. Checked 2026-10-29.',
  },
  mcpServers: {
    switch_echo: {
      transport: 'http',
      url: echo.url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
  timeoutMs: 240_000,
});
