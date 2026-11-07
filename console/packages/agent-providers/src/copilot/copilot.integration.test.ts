import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { copilotAcp, createCopilotAdapter } from './copilot-acp';

// The harness hands the CLI a minimal environment, so a token, a Copilot home
// or a bring-your-own-key provider in the shell would not reach it otherwise.
const env = Object.fromEntries(
  [...(copilotAcp.inheritEnv ?? []), 'GH_TOKEN', 'GITHUB_TOKEN'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the copilot binary is not on PATH';
    const signIn = await checkAcpSignIn(copilotAcp, {
      binaryPath: 'copilot',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return signIn.status === 'authenticated'
      ? null
      : 'Copilot CLI is not signed in (run copilot login, or set COPILOT_GITHUB_TOKEN to a token with the Copilot Requests permission)';
  },
  timeoutMs: 300_000,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
