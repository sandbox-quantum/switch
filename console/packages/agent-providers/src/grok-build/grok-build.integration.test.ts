import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { grokBuildAcp, createGrokBuildAdapter } from './grok-build-adapter';

const env = {
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.XAI_API_KEY ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}),
};

describeConformance('grok-build', {
  createAdapter: async () => createGrokBuildAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['acp', '--help'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the Grok Build CLI is not available on PATH';
    const status = await checkAcpSignIn(grokBuildAcp, {
      binaryPath: 'grok',
      cwd: process.cwd(),
      env,
    });
    return status.status === 'authenticated'
      ? null
      : `Grok Build is not signed in: ${status.message}`;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(env.XAI_API_KEY ? { env: { XAI_API_KEY: env.XAI_API_KEY } } : {}),
});
