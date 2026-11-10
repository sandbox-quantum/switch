import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createDroidAdapter, droidAcp } from './droid-adapter';

describeConformance('droid', {
  createAdapter: async () => createDroidAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('droid', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      return 'the droid binary is not on PATH';
    }
    if (!process.env.FACTORY_API_KEY) {
      return 'FACTORY_API_KEY is not set';
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.FACTORY_API_KEY ? { env: { FACTORY_API_KEY: process.env.FACTORY_API_KEY } } : {}),
});
