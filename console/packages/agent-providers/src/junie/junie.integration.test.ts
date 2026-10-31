import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter, junieAcp } from './junie-acp';

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('junie', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the junie binary is not on PATH';
    const readiness = await checkAcpSignIn(junieAcp, {
      binaryPath: 'junie',
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
        ...(process.env.JUNIE_API_KEY ? { JUNIE_API_KEY: process.env.JUNIE_API_KEY } : {}),
      },
    });
    if (readiness.status !== 'authenticated') {
      return readiness.message;
    }
    return null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.JUNIE_API_KEY ? { env: { JUNIE_API_KEY: process.env.JUNIE_API_KEY } } : {}),
});
