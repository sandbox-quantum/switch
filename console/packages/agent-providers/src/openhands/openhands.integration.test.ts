import { spawnSync } from 'node:child_process';
import { describeConformance } from '../testing/index';
import { createOpenHandsAdapter, openhandsSignedIn } from './openhands-adapter';

describeConformance('openhands', {
  createAdapter: async () => createOpenHandsAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('openhands', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the openhands binary is not on PATH';
    // The two variables the sign-in check reads, from the shell the suite
    // was started in.
    const env: Record<string, string> = {};
    for (const key of ['HOME', 'OPENHANDS_PERSISTENCE_DIR'] as const) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return (await openhandsSignedIn(env))
      ? null
      : 'OpenHands has no LLM configured on this machine (run `openhands` once)';
  },
  timeoutMs: 300_000,
  skip: {
    // OpenHands ACP (CLI 1.16) has no question channel: its only client
    // request is `session/request_permission`, for confirmation prompts.
    'user-input':
      'OpenHands ACP has no question channel: its only client request is session/request_permission, for confirmation prompts.',
    'mcp-registered':
      'OpenHands ACP asks for approval of an opaque action batch. Switch cannot safely auto-approve a registered MCP tool without identifying the actions in that batch.',
  },
  // The harness hands the CLI a minimal environment, so a home outside
  // ~/.openhands would not reach it and the session would read a different
  // home than the sign-in probe did.
  ...(process.env.OPENHANDS_PERSISTENCE_DIR
    ? { env: { OPENHANDS_PERSISTENCE_DIR: process.env.OPENHANDS_PERSISTENCE_DIR } }
    : {}),
});
