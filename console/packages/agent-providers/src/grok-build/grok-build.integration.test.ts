import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokBuildAdapter } from './grok-build-acp';

describeConformance('grok-build', {
  createAdapter: async () => createGrokBuildAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['--version'], { encoding: 'utf8', shell: true });
    return probe.error || probe.status !== 0 ? 'the grok binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.XAI_API_KEY ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } } : {}),
  skip: {
    'user-input': 'Grok Build ACP user-input support is handled via _x.ai/ask_user_question extension.',
    'steer-mid-turn': 'Grok Build ACP steering support is not advertised in handshake.',
    subagent: 'Grok Build ACP subagent support is not verified in test suite.',
    'mcp-registered': 'Grok Build CLI takes MCP servers over HTTP/SSE only; stdio MCP server is unsupported.',
    'approval-declined': 'Grok Build returns turn outcome interrupted when a permission request is declined.',
    ...(process.platform === 'win32'
      ? { 'approval-required': 'Windows PowerShell writes UTF-16LE encoding by default.' }
      : {}),
  },
});
