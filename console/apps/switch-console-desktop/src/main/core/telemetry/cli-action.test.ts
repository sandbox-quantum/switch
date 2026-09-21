import { aDurationMs } from '@tooling/utils/telemetry-duration';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('./telemetry-service', () => ({ trackEvent: mocks.trackEvent }));

import { reportedCliAction } from './cli-action';

function reported(): Record<string, unknown> {
  const call = mocks.trackEvent.mock.calls.find((c) => c[0] === 'agent_cli_action');
  if (!call) throw new Error('nothing reported agent_cli_action');
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reporting a CLI install, update or removal', () => {
  it('carries the result of an operation that came back', async () => {
    const result = await reportedCliAction('install', 'local', 'claude', 'npm', async () => ({
      success: true,
    }));

    expect(result).toEqual({ success: true });
    expect(reported()).toEqual({
      agent_type: 'claude',
      target: 'local',
      install_method: 'npm',
      action: 'install',
      outcome: 'success',
      failure_reason: 'none',
      duration_ms: aDurationMs,
    });
  });

  it('names the code a failed operation returned', async () => {
    await reportedCliAction('update', 'remote', 'codex', undefined, async () => ({
      success: false,
      error: { type: 'permission-denied' },
    }));

    expect(reported()).toMatchObject({
      target: 'remote',
      // No method was supplied, and `unspecified` says that rather than picking
      // one — every one of these paths takes the method as optional.
      install_method: 'unspecified',
      outcome: 'failure',
      failure_reason: 'permission_denied',
    });
  });

  /**
   * The gap this exists to close.
   *
   * These operations return a `Result` rather than raising, so the reporting
   * used to sit on the line after the call — and a manager that raised took its
   * attempt out of the count altogether. Not a failure in the numerator: an
   * absence from both, which silently flatters the install success rate by
   * exactly the failures that went worst.
   */
  it('reports an operation that threw, and still lets the throw through', async () => {
    const boom = new Error('ssh: connection closed');

    await expect(
      reportedCliAction('uninstall', 'remote', 'opencode', undefined, () => Promise.reject(boom))
    ).rejects.toBe(boom);

    expect(reported()).toMatchObject({
      agent_type: 'opencode',
      action: 'uninstall',
      outcome: 'failure',
      failure_reason: 'error',
      duration_ms: aDurationMs,
    });
  });

  it('reports a dependency that names no agent as unknown rather than as itself', async () => {
    // These ids are dependency ids, and a core dependency is not an agent type.
    // Passing it through would put free text in a payload.
    await reportedCliAction('install', 'remote', 'docker', undefined, async () => ({
      success: true,
    }));

    expect(reported()).toMatchObject({ agent_type: 'unknown' });
  });

  it('times the operation and nothing around it', async () => {
    const SLEEP_MS = 20;
    await reportedCliAction(
      'install',
      'local',
      'claude',
      undefined,
      () =>
        new Promise<{ success: boolean }>((resolve) =>
          setTimeout(() => resolve({ success: true }), SLEEP_MS)
        )
    );

    expect(reported().duration_ms).toBeGreaterThanOrEqual(SLEEP_MS - 5);
  });
});
