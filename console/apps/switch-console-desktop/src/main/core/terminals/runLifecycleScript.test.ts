import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveSessionSettings } from '../locations/settings/effective-session-settings';
import { resolveLocationRuntime } from '../locations/utils';
import { runLifecycleScript } from './runLifecycleScript';

const runCoordinator = vi.hoisted(() =>
  vi.fn(async ({ runtime, type, script, shellSetup }) => {
    await runtime.lifecycleService.runLifecycleScript({ type, script, shellSetup });
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

  it('runs manual lifecycle commands with the location settings', async () => {
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

    expect(lifecycleRun).toHaveBeenCalledWith({
      type: 'run',
      script: 'pnpm dev',
      shellSetup: 'source .envrc',
    });
    expect(runCoordinator).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      locationId: 'loc-1',
      sessionId: 'session-1',
      type: 'run',
      script: 'pnpm dev',
      shellSetup: 'source .envrc',
      origin: 'manual',
      policy: {
        logFailure: true,
        surfaceFailure: true,
        continueOnFailure: false,
      },
      logPrefix: 'TerminalsController',
    });
  });
});
