import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAmpAdapter } from './amp-adapter';

describeConformance('amp', {
  createAdapter: async () => createAmpAdapter(),
  unavailableReason: async () => {
    const probeAcp = spawnSync('amp-acp', ['--version'], { encoding: 'utf8', timeout: 5000 });
    const probeAmp = spawnSync('amp', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if ((probeAcp.error || probeAcp.status !== 0) && (probeAmp.error || probeAmp.status !== 0)) {
      return 'neither amp-acp nor amp binary is on PATH';
    }
    if (!process.env.AMP_API_KEY && !process.env.SRC_ACCESS_TOKEN) {
      return 'AMP_API_KEY is not set';
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.AMP_API_KEY ? { env: { AMP_API_KEY: process.env.AMP_API_KEY } } : {}),
});
