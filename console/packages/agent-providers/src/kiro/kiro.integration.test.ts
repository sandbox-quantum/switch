import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the kiro-cli binary is not on PATH';
    // Signed out, `whoami` exits 1 and every session start is refused. It
    // exits 0 for a login or a KIRO_API_KEY.
    const whoami = spawnSync('kiro-cli', ['whoami', '--format', 'json'], { encoding: 'utf8' });
    return whoami.status === 0 ? null : 'kiro-cli is not signed in (run kiro-cli login)';
  },
  // Kiro hands longer tasks to sub-agents, which run a whole nested
  // conversation each.
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and Kiro would refuse to start signed out.
  ...(process.env.KIRO_API_KEY ? { env: { KIRO_API_KEY: process.env.KIRO_API_KEY } } : {}),
});
