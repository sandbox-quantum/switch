import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

const env: Record<string, string> = {};
for (const key of [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'SystemRoot',
  'MISTRAL_API_KEY',
  'VIBE_HOME',
]) {
  const value = process.env[key];
  if (value) env[key] = value;
}

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    const version = spawnSync('vibe-acp', ['--version'], { encoding: 'utf8' });
    if (version.error || version.status !== 0) return 'vibe-acp is not installed on PATH';
    const status = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: tmpdir(),
      env,
    });
    return status.status === 'authenticated' ? null : status.message;
  },
  env,
  ...(process.env.SWITCH_VIBE_MODEL ? { model: { id: process.env.SWITCH_VIBE_MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'user-input':
      'Vibe 3.1.0 (source reviewed 2026-11-06) requires ACP elicitation for questions; this adapter does not advertise it.',
  },
});
