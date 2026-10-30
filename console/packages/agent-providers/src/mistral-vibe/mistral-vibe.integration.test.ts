import { spawnSync } from 'node:child_process';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'LANG',
    'TERM',
    'MISTRAL_API_KEY',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the vibe-acp binary is not on PATH';
    const result = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: process.cwd(),
      env: inheritedEnvironment(),
    });
    return result.status === 'authenticated' ? null : result.message;
  },
  skip: {
    'user-input':
      'Mistral Vibe 3.0.2 exposes questions through ACP elicitation, which the Switch ACP client does not advertise (2026-10-26).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.MISTRAL_API_KEY ? { env: { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } } : {}),
});
