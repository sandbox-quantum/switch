import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter } from './kimi-adapter';

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kimi binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
