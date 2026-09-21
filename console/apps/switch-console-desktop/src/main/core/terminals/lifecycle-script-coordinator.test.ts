import { describe, expect, it, vi } from 'vitest';
import type { LocationRuntime } from '@main/core/locations/location-runtime';
import { runLifecycleScriptWithPolicy } from './lifecycle-script-coordinator';
const emit = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@main/lib/file-logger', () => ({ redactDiagnosticLog: (text: string) => text }));
function args(runLifecycleScript: ReturnType<typeof vi.fn>, stop = vi.fn()) {
  return {
    runtime: { lifecycleService: { runLifecycleScript, stop } } as unknown as LocationRuntime,
    locationId: 'location',
    sessionId: 'session',
    type: 'run' as const,
    script: 'serve',
    origin: 'manual' as const,
    policy: { logFailure: true, surfaceFailure: true, continueOnFailure: false },
    logPrefix: 'test',
  };
}
describe('lifecycle policy', () => {
  it('reports failed exit codes to the caller', async () => {
    const options = args(
      vi.fn(async () => ({ kind: 'exited', exitCode: 2, outputTail: 'failed' }))
    );
    await expect(runLifecycleScriptWithPolicy(options)).rejects.toThrow('code 2');
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' })
    );
  });
  it('stops timed-out commands before surfacing failure', async () => {
    const stop = vi.fn();
    const options = args(
      vi.fn(() => new Promise(() => {})),
      stop
    );
    await expect(
      runLifecycleScriptWithPolicy({ ...options, policy: { ...options.policy, timeoutMs: 5 } })
    ).rejects.toThrow('timed out');
    expect(stop).toHaveBeenCalledWith('run');
  });
});
