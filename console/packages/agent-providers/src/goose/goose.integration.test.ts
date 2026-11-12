import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter } from './goose-adapter';

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  skip: {
    'user-input':
      'Goose 1.57.0 asks through ACP form elicitation; the generic ACP client does not advertise it (hooks set userInput: false). Verified 2026-11-04.',
  },
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['info', '-v'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the goose binary is not on PATH';
    return /^[ \t]+GOOSE_PROVIDER:/m.test(probe.stdout)
      ? null
      : 'Goose has no provider configured; run `goose configure`';
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment. Goose reads its provider
  // and model from its config; a headless machine has no keyring to read the
  // provider's key from, so it is read from Goose's secrets file instead.
  env: { GOOSE_DISABLE_KEYRING: '1' },
});
