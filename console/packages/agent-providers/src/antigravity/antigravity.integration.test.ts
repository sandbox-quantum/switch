import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAntigravityAdapter } from './antigravity-adapter';

describeConformance('antigravity', {
  createAdapter: async () => createAntigravityAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('antigravity-acp', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the antigravity-acp binary is not on PATH' : null;
  },
  // `invoke_subagent` runs a whole nested conversation, which can outlast the
  // default deadline on a slow day.
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
});
