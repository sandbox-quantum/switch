import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRecorder } from '../testing/event-recorder';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter } from './junie-adapter';

const TOKEN = 'SWITCH_CONFORMANCE_OK';

/**
 * Whether the signed-in account this suite runs under can actually complete a
 * turn, not just start a session — session creation (and so `checkSignIn`)
 * succeeds the same way with or without an active subscription, but
 * `session/prompt` silently answers `stopReason: "cancelled"` with zero
 * tokens spent when the account has none (checked live, 2026-11-06, Junie
 * 26.11.3 (3959.5): "No active AI subscription found", a Junie API key
 * entered with no promo code or paid plan). This runs that one real turn so
 * the skip reason is accurate for whichever account the suite is run under,
 * not a hardcoded assumption.
 */
async function turnsAreFree(): Promise<string | null> {
  const probe = spawnSync('junie', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'the junie binary is not on PATH';
  const adapter = createJunieAdapter();
  const cwd = await mkdtemp(join(tmpdir(), 'junie-availability-'));
  try {
    const recorder = new EventRecorder(adapter);
    const sessionId = 'availability-check';
    await adapter.startSession({
      sessionId,
      cwd,
      runtimeMode: 'full-access',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      mcpServers: {},
      connectorMcpServers: [],
    });
    await adapter.sendTurn({
      sessionId,
      turnId: 'availability-turn',
      text: `Reply with exactly ${TOKEN}.`,
    });
    const done = await recorder.waitFor(
      'turn.completed',
      (e) => e.turnId === 'availability-turn',
      30_000
    );
    if (done.outcome === 'completed' && recorder.assistantText('availability-turn').includes(TOKEN))
      return null;
    return (
      'Junie 26.11.3 (3959.5) did not complete a turn on this account (checked 2026-11-06): ' +
      `outcome "${done.outcome}", no active JetBrains AI subscription or promo-code trial tokens ` +
      'on the Junie API key used. Sign in with an account that has one (jetbrains.com/junie) to ' +
      'run this suite for real.'
    );
  } catch (error) {
    return `Junie's availability check failed: ${String(error)}`;
  } finally {
    await adapter.stopAll();
    await rm(cwd, { recursive: true, force: true });
  }
}

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: turnsAreFree,
  skip: {
    // No ask-the-user tool was observed, but no real turn ran on the account
    // used to check for one, either (checked 2026-11-06).
    'user-input':
      'No ask-the-user mechanism is documented or was observed over ACP for Junie 26.11.3 (3959.5), but this was not checked against a real turn (checked 2026-11-06).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
