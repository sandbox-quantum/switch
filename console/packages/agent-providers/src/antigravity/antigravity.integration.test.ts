import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAntigravityAdapter } from './antigravity-adapter';

describeConformance('antigravity', {
  createAdapter: async () => createAntigravityAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('agy', ['--help'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the agy binary is not on PATH' : null;
  },
  // `invoke_subagent` runs a whole nested conversation, which can outlast the
  // default deadline on a slow day.
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'approval-required':
      'Headless agy has no prompt channel: a tool that needs permission is auto-denied and no request can be opened.',
    'approval-declined':
      'Headless agy has no prompt channel: a tool that needs permission is auto-denied and no request can be opened.',
    'user-input':
      'Headless agy skips ask_question outright; the model is told the question was skipped and there is nothing to answer.',
  },
});
