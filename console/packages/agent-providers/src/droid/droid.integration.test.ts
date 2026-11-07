import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createDroidAdapter } from './droid-acp';

describeConformance('droid', {
  createAdapter: async () => createDroidAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('droid', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the Droid binary is not on PATH' : null;
  },
  skip: {
    'user-input': 'Droid runs autonomously without inline ACP user-input queries.',
    subagent:
      'Droid subagent delegation is handled internally rather than via ACP subagent lifecycle.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.FACTORY_API_KEY ? { env: { FACTORY_API_KEY: process.env.FACTORY_API_KEY } } : {}),
});
