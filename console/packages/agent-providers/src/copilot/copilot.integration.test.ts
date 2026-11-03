import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createCopilotAdapter } from './copilot-adapter';

describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the copilot binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
