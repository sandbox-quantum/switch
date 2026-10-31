import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createDroidAdapter, hasFactoryAuth } from './droid-acp';

describeConformance('droid', {
  createAdapter: async () => createDroidAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('droid', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the droid binary is not on PATH';
    if (
      !process.env.FACTORY_API_KEY &&
      !(await hasFactoryAuth(process.env as Record<string, string>))
    ) {
      return 'no Factory credentials found; set FACTORY_API_KEY or run `droid` to sign in';
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.FACTORY_API_KEY ? { env: { FACTORY_API_KEY: process.env.FACTORY_API_KEY } } : {}),
});
