import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter, kiroAcp } from './kiro-acp';

const BINARY = process.env['SWITCH_KIRO_BIN'] ?? 'kiro-cli';
// The harness hands the CLI a minimal environment, so a key in the shell
// would not reach it and Kiro would read as signed out.
const ENV: Record<string, string> = process.env['KIRO_API_KEY']
  ? { KIRO_API_KEY: process.env['KIRO_API_KEY'] }
  : {};

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    const probe = spawnSync(BINARY, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    if (probe.error || probe.status !== 0) return `\`${BINARY}\` is not on PATH`;
    const signIn = await checkAcpSignIn(kiroAcp, {
      binaryPath: BINARY,
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), ...ENV },
    });
    return signIn.status === 'authenticated' ? null : signIn.message;
  },
  ...(process.env['SWITCH_KIRO_MODEL'] ? { model: { id: process.env['SWITCH_KIRO_MODEL'] } } : {}),
  env: ENV,
  mcpServers: { echo: echoMcpServerSpec() },
});
