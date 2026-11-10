import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kiro-cli binary is not on PATH' : null;
  },
  // A delegated subagent turn runs a whole nested conversation, and the free
  // Builder ID tier answers slowly on a cold start; the merged Antigravity
  // suite uses the same per-scenario deadline for the same reason.
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'Kiro CLI exposes no ask-the-user request over ACP: its initialize answer lists no question extension method and a session never emits one (verified against real CLI, 2026-11-05), so there is no protocol request for the adapter to answer.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.KIRO_API_KEY ? { env: { KIRO_API_KEY: process.env.KIRO_API_KEY } } : {}),
});
