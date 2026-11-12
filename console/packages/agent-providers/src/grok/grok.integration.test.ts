import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokAdapter, grokAcp } from './grok-acp';

const BINARY = process.env['SWITCH_GROK_BIN'] ?? 'grok';
// The harness hands the CLI a minimal environment, so a key in the shell
// would not reach it and Grok would read as signed out.
const ENV: Record<string, string> = process.env['XAI_API_KEY']
  ? { XAI_API_KEY: process.env['XAI_API_KEY'] }
  : {};

describeConformance('grok', {
  createAdapter: async () => createGrokAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    const probe = spawnSync(BINARY, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    if (probe.error || probe.status !== 0) return `\`${BINARY}\` is not on PATH`;
    const signIn = await checkAcpSignIn(grokAcp, {
      binaryPath: BINARY,
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), ...ENV },
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  },
  ...(process.env['SWITCH_GROK_MODEL'] ? { model: { id: process.env['SWITCH_GROK_MODEL'] } } : {}),
  env: ENV,
  mcpServers: { echo: echoMcpServerSpec() },
});
