import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter } from './junie-adapter';

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('junie', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the junie binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
