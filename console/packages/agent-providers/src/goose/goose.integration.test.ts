import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter, gooseAcp } from './goose-adapter';

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['acp', '--help'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      return 'the Goose ACP binary is not available';
    }
    const readiness = await gooseAcp.checkSignIn?.({
      binaryPath: 'goose',
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    if (readiness && readiness.status !== 'authenticated') {
      return `Goose is not configured (${readiness.message})`;
    }
    return null;
  },
  skip: {
    'user-input': 'Goose does not implement user-input questions over ACP.',
    subagent: 'Goose delegates through extensions rather than native ACP subagent items.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.GOOSE_PROVIDER ? { env: { GOOSE_PROVIDER: process.env.GOOSE_PROVIDER } } : {}),
  ...(process.env.GOOSE_MODEL ? { env: { GOOSE_MODEL: process.env.GOOSE_MODEL } } : {}),
});
