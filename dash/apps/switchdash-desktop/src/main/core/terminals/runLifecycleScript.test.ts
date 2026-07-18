import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveSessionSettings } from '../locations/settings/effective-session-settings';
import { resolveLocationRuntime } from '../locations/utils';
import { runLifecycleScript } from './runLifecycleScript';

const runCoordinator = vi.hoisted(() =>
  vi.fn(async ({ runtime, type, script, shellSetup, policy }) => {
    await runtime.lifecycleService.runLifecycleScript(
      { type, script, shellSetup },
      {
        exit: policy.exit ?? true,
        waitForExit: policy.waitForExit ?? true,
        respawnAfterExit: policy.respawnAfterExit ?? false,
      }
    );
  })
);

vi.mock('../locations/settings/effective-session-settings', () => ({
  getEffectiveSessionSettings: vi.fn(),
}));

vi.mock('../locations/utils', () => ({
  resolveLocationRuntime: vi.fn(),
}));

vi.mock('./lifecycle-script-coordinator', () => ({
  runLifecycleScriptWithPolicy: runCoordinator,
}));

describe('runLifecycleScript', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs manual lifecycle scripts with exit and restores the prompt afterward', async () => {
    const lifecycleRun = vi.fn(async () => {});
    vi.mocked(resolveLocationRuntime).mockReturnValue({
      settings: {},
      fs: {},
      lifecycleService: {
        runLifecycleScript: lifecycleRun,
      },
    } as never);
    vi.mocked(getEffectiveSessionSettings).mockResolvedValue({
      shellSetup: 'source .envrc',
      scripts: {
        run: 'pnpm dev',
      },
    } as never);

    await runLifecycleScript({
      locationId: 'loc-1',
      sessionId: 'session-1',
      type: 'run',
    });

    expect(lifecycleRun).toHaveBeenCalledWith(
      { type: 'run', script: 'pnpm dev', shellSetup: 'source .envrc' },
      { exit: true, waitForExit: true, respawnAfterExit: true }
    );
    expect(runCoordinator).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      locationId: 'loc-1',
      sessionId: 'session-1',
      type: 'run',
      script: 'pnpm dev',
      shellSetup: 'source .envrc',
      origin: 'manual',
      policy: {
        respawnAfterExit: true,
        logFailure: true,
        surfaceFailure: true,
        continueOnFailure: false,
      },
      logPrefix: 'TerminalsController',
    });
  });
});
