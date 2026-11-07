import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['whoami', '--format', 'json'], { encoding: 'utf8' });
    if (probe.error) return 'the kiro-cli binary is not on PATH';
    return probe.status !== 0 ? 'kiro-cli is not signed in; run kiro-cli login' : null;
  },
  // A named model rather than Kiro's `auto`, so every turn also goes through
  // the model selection a Switch agent makes. claude-haiku-4.5 declined to
  // repeat the resume scenario's secret word.
  model: { id: process.env.KIRO_CONFORMANCE_MODEL ?? 'claude-sonnet-4.5' },
  skip: {
    'user-input':
      'kiro-cli 2.34.0 has no ask-the-user tool on either agent engine (v2, v3); it asks its question as plain text (2026-10-26).',
    interrupt:
      'kiro-cli 2.34.0 ends the interrupted turn, but sometimes answers the next prompt with stopReason "cancelled" without running it (4 of 6 full runs, 0 of 9 runs of this scenario alone); a resend works (2026-10-26).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
