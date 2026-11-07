import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter } from './junie-adapter';

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('junie', ['--version'], { encoding: 'utf8', shell: true });
    return probe.error || probe.status !== 0 ? 'the Junie CLI binary is not available' : null;
  },
  skip: {
    'user-input':
      'Junie operates primarily non-interactively over ACP without exposing interactive terminal prompt tools.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.JUNIE_API_KEY ? { env: { JUNIE_API_KEY: process.env.JUNIE_API_KEY } } : {}),
});
