import { describe, expect, it, vi } from 'vitest';
import {
  isPlanComplete,
  type HostSetupPlan,
  type HostSetupStep,
} from '@shared/core/remote-hosts/setup';
import {
  HostSetupAbortedError,
  HostSetupRunner,
  type StepCheckResult,
  type StepInstallResult,
} from './host-setup-runner';

function step(id: string, patch: Partial<HostSetupStep> = {}): HostSetupStep {
  return {
    id,
    kind: 'core-dependency',
    name: id,
    state: 'pending',
    outcome: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function plan(steps: HostSetupStep[]): HostSetupPlan {
  return {
    sshHost: 'dev-vm',
    status: 'idle',
    steps,
    currentStepId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type Harness = {
  checks: Record<string, StepCheckResult[]>;
  installs: Record<string, StepInstallResult>;
  updates?: Record<string, StepInstallResult>;
  canInstall?: (id: string) => boolean;
  reachable?: boolean;
};

class Unreachable extends Error {}

function makeRunner(harness: Harness) {
  const saved: HostSetupPlan[] = [];
  const published: HostSetupPlan[] = [];
  const installOrder: string[] = [];
  const updateOrder: string[] = [];
  const checkOrder: string[] = [];
  const inFlight = { count: 0, max: 0 };

  const runner = new HostSetupRunner({
    sshHost: 'dev-vm',
    load: async () => null,
    save: async (p) => void saved.push(structuredClone(p)),
    publish: (p) => published.push(structuredClone(p)),
    check: async (s) => {
      checkOrder.push(s.id);
      const queue = harness.checks[s.id] ?? [{ outcome: 'satisfied' }];
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    install: async (s) => {
      installOrder.push(s.id);
      inFlight.count += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.count);
      await Promise.resolve();
      inFlight.count -= 1;
      return harness.installs[s.id] ?? { ok: true };
    },
    update: async (s) => {
      updateOrder.push(s.id);
      return harness.updates?.[s.id] ?? { ok: true };
    },
    canInstall: (s) => harness.canInstall?.(s.id) ?? true,
    requireReachable: () => {
      if (harness.reachable === false) throw new Unreachable('host down');
    },
    now: () => new Date('2026-02-02T00:00:00.000Z'),
  });

  return { runner, saved, published, installOrder, updateOrder, checkOrder, inFlight };
}

const stateOf = (p: HostSetupPlan, id: string) => p.steps.find((s) => s.id === id)!.state;

describe('installing one step', () => {
  it('does not install something already there', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { git: [{ outcome: 'satisfied', version: '2.43.0' }] },
      installs: {},
    });

    const result = await runner.runSingleStep(plan([step('git')]), 'git');

    expect(stateOf(result, 'git')).toBe('satisfied');
    expect(installOrder).toEqual([]);
  });

  it('installs, then verifies by re-probing', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { node: [{ outcome: 'missing' }, { outcome: 'satisfied', version: '22.0.0' }] },
      installs: { node: { ok: true } },
    });

    const result = await runner.runSingleStep(plan([step('node')]), 'node');

    expect(installOrder).toEqual(['node']);
    expect(stateOf(result, 'node')).toBe('satisfied');
    expect(result.steps[0]!.version).toBe('22.0.0');
  });

  it('fails when an install reports success but verification disagrees', async () => {
    // The installer's exit code is a claim; only the re-check is evidence.
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'missing' }, { outcome: 'missing' }] },
      installs: { node: { ok: true } },
    });

    const result = await runner.runSingleStep(plan([step('node')]), 'node');

    expect(stateOf(result, 'node')).toBe('failed');
    expect(result.steps[0]!.error).toContain('still reports "missing" after installing');
  });

  it("preserves the installer's own error and command output", async () => {
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'missing' }] },
      installs: { node: { ok: false, error: 'permission denied', output: 'sudo: no tty' } },
    });

    const result = await runner.runSingleStep(plan([step('node')]), 'node');

    expect(result.steps[0]!.error).toBe('permission denied');
    expect(result.steps[0]!.output).toBe('sudo: no tty');
  });

  it('records unknown — never missing — when a probe throws', async () => {
    const runner = new HostSetupRunner({
      sshHost: 'dev-vm',
      load: async () => null,
      save: async () => {},
      publish: () => {},
      check: async () => {
        throw new Error('ssh channel closed');
      },
      install: async () => ({ ok: true }),
      update: async () => ({ ok: true }),
      canInstall: () => true,
      requireReachable: () => {},
      now: () => new Date('2026-02-02T00:00:00.000Z'),
    });

    const result = await runner.runSingleStep(plan([step('docker')]), 'docker');

    expect(result.steps[0]!.outcome).toBe('unknown');
    expect(stateOf(result, 'docker')).toBe('failed');
  });

  it('does not run an installer over a service that is merely stopped', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { docker: [{ outcome: 'not-running' }] },
      installs: {},
    });

    const result = await runner.runSingleStep(plan([step('docker')]), 'docker');

    expect(installOrder).toEqual([]);
    expect(result.steps[0]!.error).toContain('not running');
  });

  it('says there is no install command rather than silently stalling', async () => {
    const { runner } = makeRunner({
      checks: { tmux: [{ outcome: 'missing' }] },
      installs: {},
      canInstall: () => false,
    });

    const result = await runner.runSingleStep(plan([step('tmux')]), 'tmux');

    expect(stateOf(result, 'tmux')).toBe('failed');
    expect(result.steps[0]!.error).toContain('no install command');
  });

  it('clears a previous error when the step is retried', async () => {
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'missing' }, { outcome: 'satisfied' }] },
      installs: { node: { ok: true } },
    });

    const result = await runner.runSingleStep(
      plan([step('node', { state: 'failed', error: 'apt-get failed', output: 'E: broken' })]),
      'node'
    );

    expect(stateOf(result, 'node')).toBe('satisfied');
    expect(result.steps[0]!.error).toBeNull();
    expect(result.steps[0]!.output).toBeNull();
  });

  it('leaves every other step untouched', async () => {
    const { runner } = makeRunner({
      checks: { git: [{ outcome: 'missing' }, { outcome: 'satisfied' }] },
      installs: { git: { ok: true } },
    });

    const result = await runner.runSingleStep(
      plan([step('git'), step('node'), step('tmux', { state: 'satisfied' })]),
      'git'
    );

    expect(stateOf(result, 'node')).toBe('pending');
    expect(stateOf(result, 'tmux')).toBe('satisfied');
  });

  it('refuses to interleave with another operation on the same host', async () => {
    const { runner } = makeRunner({
      checks: { git: [{ outcome: 'missing' }, { outcome: 'satisfied' }] },
      installs: { git: { ok: true } },
    });
    const p = plan([step('git')]);

    const [first, second] = await Promise.allSettled([
      runner.runSingleStep(p, 'git'),
      runner.runSingleStep(p, 'git'),
    ]);

    expect([first!.status, second!.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('persists and publishes every transition', async () => {
    const { runner, saved, published } = makeRunner({
      checks: { git: [{ outcome: 'missing' }, { outcome: 'satisfied' }] },
      installs: { git: { ok: true } },
    });

    await runner.runSingleStep(plan([step('git')]), 'git');

    expect(saved.length).toBeGreaterThan(1);
    expect(published.length).toBe(saved.length);
  });

  it('aborts as unreachable instead of blaming a dependency', async () => {
    const { runner } = makeRunner({ checks: {}, installs: {}, reachable: false });

    await expect(runner.runSingleStep(plan([step('git')]), 'git')).rejects.toBeInstanceOf(
      HostSetupAbortedError
    );
  });
});

describe('skipping', () => {
  it('is never reported as satisfied', async () => {
    const { runner } = makeRunner({ checks: {}, installs: {} });

    const result = await runner.skip(plan([step('gh'), step('node')]), 'gh');

    expect(stateOf(result, 'gh')).toBe('skipped');
    expect(isPlanComplete(result)).toBe(false);
  });

  it('completes the plan when the last outstanding step is optional and skipped', async () => {
    const { runner } = makeRunner({ checks: {}, installs: {} });

    const result = await runner.skip(
      plan([step('node', { state: 'satisfied' }), step('gh', { optional: true })]),
      'gh'
    );

    expect(result.status).toBe('complete');
  });
});

describe('plan helpers', () => {
  it('treats a skipped required step as outstanding, not done', async () => {
    const { isPlanComplete } = await import('@shared/core/remote-hosts/setup');
    expect(isPlanComplete(plan([step('node', { state: 'skipped' })]))).toBe(false);
  });

  it('ignores optional steps when deciding completeness', async () => {
    const { isPlanComplete } = await import('@shared/core/remote-hosts/setup');
    expect(
      isPlanComplete(
        plan([
          step('node', { state: 'satisfied' }),
          step('gh', { optional: true, state: 'failed' }),
        ])
      )
    ).toBe(true);
  });
});

describe('checkAll — looking without touching', () => {
  it('installs nothing, whatever it finds', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { git: [{ outcome: 'satisfied' }], node: [{ outcome: 'missing' }] },
      installs: {},
    });

    await runner.checkAll(plan([step('git'), step('node')]));

    expect(installOrder).toEqual([]);
  });

  it('records what it saw on steps it leaves pending', async () => {
    // The distinction the UI depends on: "not checked" vs "checked, and absent".
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'missing' }] },
      installs: {},
    });

    const result = await runner.checkAll(plan([step('node')]));

    expect(stateOf(result, 'node')).toBe('pending');
    expect(result.steps[0]!.outcome).toBe('missing');
  });

  it('marks what is genuinely there as satisfied', async () => {
    const { runner } = makeRunner({
      checks: { git: [{ outcome: 'satisfied', version: '2.43.0' }] },
      installs: {},
    });

    const result = await runner.checkAll(plan([step('git')]));

    expect(stateOf(result, 'git')).toBe('satisfied');
    expect(result.status).toBe('complete');
  });

  it('checks every step rather than stopping at the first problem', async () => {
    // Unlike a run, there is nothing to halt for — the point is a full picture.
    const { runner } = makeRunner({
      checks: {
        git: [{ outcome: 'missing' }],
        node: [{ outcome: 'missing' }],
        tmux: [{ outcome: 'satisfied' }],
      },
      installs: {},
    });

    const result = await runner.checkAll(plan([step('git'), step('node'), step('tmux')]));

    expect(result.steps.map((s) => s.outcome)).toEqual(['missing', 'missing', 'satisfied']);
    expect(stateOf(result, 'tmux')).toBe('satisfied');
  });

  it('supersedes a previous failure rather than leaving its error behind', async () => {
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'satisfied', version: '22.0.0' }] },
      installs: {},
    });

    const result = await runner.checkAll(
      plan([step('node', { state: 'failed', error: 'apt-get failed', output: 'E: broken' })])
    );

    expect(stateOf(result, 'node')).toBe('satisfied');
    expect(result.steps[0]!.error).toBeNull();
    expect(result.steps[0]!.output).toBeNull();
  });

  it('aborts as unreachable rather than reporting everything missing', async () => {
    const { runner } = makeRunner({ checks: {}, installs: {}, reachable: false });

    await expect(runner.checkAll(plan([step('git')]))).rejects.toBeInstanceOf(
      HostSetupAbortedError
    );
  });
});

/**
 * The per-row re-check. `checkAll` costs an SSH round trip per step, which is a
 * lot to pay to answer "is this one thing still installed?".
 */
describe('checkStep — re-checking a single row', () => {
  it('probes only the step asked for', async () => {
    const { runner, checkOrder } = makeRunner({
      checks: { git: [{ outcome: 'satisfied' }], node: [{ outcome: 'missing' }] },
      installs: {},
    });

    await runner.checkStep(plan([step('git'), step('node')]), 'node');

    expect(checkOrder).toEqual(['node']);
  });

  it('installs nothing, whatever it finds', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { node: [{ outcome: 'missing' }] },
      installs: {},
    });

    await runner.checkStep(plan([step('node')]), 'node');

    expect(installOrder).toEqual([]);
  });

  it('records what it saw and leaves the step pending, not failed', async () => {
    // Same distinction the whole-host re-check preserves: "checked, and absent"
    // is not "we tried to fix it and could not".
    const { runner } = makeRunner({ checks: { node: [{ outcome: 'missing' }] }, installs: {} });

    const result = await runner.checkStep(plan([step('node')]), 'node');

    expect(stateOf(result, 'node')).toBe('pending');
    expect(result.steps[0]!.outcome).toBe('missing');
  });

  it('marks a step that is genuinely there as satisfied', async () => {
    const { runner } = makeRunner({
      checks: { git: [{ outcome: 'satisfied', version: '2.43.0' }] },
      installs: {},
    });

    const result = await runner.checkStep(plan([step('git')]), 'git');

    expect(stateOf(result, 'git')).toBe('satisfied');
    expect(result.steps[0]!.version).toBe('2.43.0');
  });

  it('notices something that has gone away since it was last verified', async () => {
    // The question the button exists to answer.
    const { runner } = makeRunner({ checks: { git: [{ outcome: 'missing' }] }, installs: {} });

    const result = await runner.checkStep(
      plan([step('git', { state: 'satisfied', outcome: 'satisfied', version: '2.43.0' })]),
      'git'
    );

    expect(stateOf(result, 'git')).toBe('pending');
    expect(result.steps[0]!.outcome).toBe('missing');
  });

  it('leaves every other step untouched', async () => {
    const { runner } = makeRunner({ checks: { git: [{ outcome: 'missing' }] }, installs: {} });

    const result = await runner.checkStep(
      plan([step('git'), step('node'), step('tmux', { state: 'satisfied' })]),
      'git'
    );

    expect(stateOf(result, 'node')).toBe('pending');
    expect(stateOf(result, 'tmux')).toBe('satisfied');
  });

  it('supersedes a previous failure rather than leaving its error behind', async () => {
    const { runner } = makeRunner({
      checks: { node: [{ outcome: 'satisfied', version: '22.0.0' }] },
      installs: {},
    });

    const result = await runner.checkStep(
      plan([step('node', { state: 'failed', error: 'apt-get failed', output: 'E: broken' })]),
      'node'
    );

    expect(result.steps[0]!.error).toBeNull();
    expect(result.steps[0]!.output).toBeNull();
  });

  it('reports the plan complete once the last outstanding step checks out', async () => {
    const { runner } = makeRunner({ checks: { node: [{ outcome: 'satisfied' }] }, installs: {} });

    const result = await runner.checkStep(
      plan([step('git', { state: 'satisfied' }), step('node')]),
      'node'
    );

    expect(result.status).toBe('complete');
  });

  it('aborts as unreachable rather than reporting the step missing', async () => {
    const { runner } = makeRunner({ checks: {}, installs: {}, reachable: false });

    await expect(runner.checkStep(plan([step('git')]), 'git')).rejects.toBeInstanceOf(
      HostSetupAbortedError
    );
  });

  it('refuses to interleave with another operation on the same host', async () => {
    // The UI disables the buttons, but the runner is what actually guarantees it.
    const { runner } = makeRunner({ checks: { git: [{ outcome: 'satisfied' }] }, installs: {} });
    const p = plan([step('git')]);

    const [first, second] = await Promise.allSettled([
      runner.checkStep(p, 'git'),
      runner.checkAll(p),
    ]);

    expect([first!.status, second!.status].sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('plan completion', () => {
  it('reports the plan complete once the last outstanding step is installed', async () => {
    const { runner } = makeRunner({
      checks: { git: [{ outcome: 'missing' }, { outcome: 'satisfied' }] },
      installs: { git: { ok: true } },
    });

    const result = await runner.runSingleStep(
      plan([step('git'), step('node', { state: 'satisfied' })]),
      'git'
    );

    expect(result.status).toBe('complete');
  });
});

describe('gh-auth steps', () => {
  const ghStep = (patch: Partial<HostSetupStep> = {}) =>
    step('gh:auth', { kind: 'gh-auth', name: 'GitHub CLI login', optional: true, ...patch });

  it('tells the user to sign in rather than reporting a missing install command', async () => {
    const { runner, installOrder } = makeRunner({
      checks: { 'gh:auth': [{ outcome: 'missing' }] },
      installs: {},
      canInstall: () => false,
    });

    const result = await runner.runSingleStep(plan([ghStep()]), 'gh:auth');

    expect(installOrder).toEqual([]);
    expect(result.steps[0]!.error).toMatch(/Use Sign in to start it/);
  });

  it('leads with why a login that already exists is still not enough', async () => {
    const { runner } = makeRunner({
      checks: {
        'gh:auth': [
          {
            outcome: 'missing',
            error: 'The GitHub token is missing the read:packages scope.',
          },
        ],
      },
      installs: {},
      canInstall: () => false,
    });

    const result = await runner.runSingleStep(plan([ghStep()]), 'gh:auth');

    expect(result.steps[0]!.state).toBe('failed');
    expect(result.steps[0]!.error).toMatch(
      /^The GitHub token is missing the read:packages scope\./
    );
  });
});

describe('runner determinism', () => {
  it('does not mutate the plan it was given', async () => {
    const { runner } = makeRunner({ checks: { git: [{ outcome: 'satisfied' }] }, installs: {} });
    const original = plan([step('git')]);
    const snapshot = structuredClone(original);

    await runner.runSingleStep(original, 'git');

    expect(original).toEqual(snapshot);
  });

  it('stamps updatedAt on every changed step', async () => {
    const { runner } = makeRunner({ checks: { git: [{ outcome: 'satisfied' }] }, installs: {} });
    vi.useFakeTimers();

    const result = await runner.runSingleStep(plan([step('git')]), 'git');

    expect(result.steps[0]!.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    vi.useRealTimers();
  });
});

/**
 * Updating is not installing (CHOO-1809).
 *
 * `runStep` returns the moment it observes a satisfied step, which is right for
 * an install and useless for an update — the whole premise of an update is that
 * the thing is already there.
 */
describe('updating one step', () => {
  const installed = (patch: Partial<HostSetupStep> = {}) =>
    step('claude', {
      state: 'satisfied',
      outcome: 'satisfied',
      version: '2.1.0',
      latestVersion: '2.2.0',
      updateAvailable: true,
      ...patch,
    });

  it('runs the update and verifies it by re-probing', async () => {
    const { runner, updateOrder, checkOrder } = makeRunner({
      checks: { claude: [{ outcome: 'satisfied', version: '2.2.0' }] },
      installs: {},
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(updateOrder).toEqual(['claude']);
    expect(checkOrder).toEqual(['claude']);
    expect(stateOf(result, 'claude')).toBe('satisfied');
    expect(result.steps[0]!.version).toBe('2.2.0');
  });

  it('refuses when no update is known to be available', async () => {
    // Without a known newer version there is nothing to update *to*, and the
    // remove-then-add fallback some CLIs use would uninstall a working plugin
    // to reinstall the very same one.
    const { runner, updateOrder } = makeRunner({ checks: {}, installs: {} });

    await expect(
      runner.updateStep(
        plan([installed({ latestVersion: null, updateAvailable: false })]),
        'claude'
      )
    ).rejects.toThrow(/no update is known/i);
    expect(updateOrder).toEqual([]);
  });

  /**
   * A failed update is not a broken dependency.
   *
   * Marking the step `failed` while its last observation was still `satisfied`
   * rendered a red badge reading "Ready" — the label names the observation. The
   * state has to come from looking, not from the updater's exit code.
   */
  it('stays installed when the update failed but the thing is still there', async () => {
    const { runner } = makeRunner({
      checks: { claude: [{ outcome: 'satisfied', version: '2.1.0' }] },
      installs: {},
      updates: { claude: { ok: false, error: 'network unreachable' } },
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(stateOf(result, 'claude')).toBe('satisfied');
    expect(result.steps[0]!.version).toBe('2.1.0');
  });

  it('still reports why the update failed', async () => {
    const { runner } = makeRunner({
      checks: { claude: [{ outcome: 'satisfied', version: '2.1.0' }] },
      installs: {},
      updates: { claude: { ok: false, error: 'network unreachable' } },
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(result.steps[0]!.error).toBe('network unreachable');
  });

  it('fails when a failed update took the thing with it', async () => {
    // Codex updates by removing and re-adding. A remove that succeeded and an
    // add that did not leaves nothing installed, and assuming otherwise would
    // report a working agent that is not there.
    const { runner } = makeRunner({
      checks: { claude: [{ outcome: 'missing' }] },
      installs: {},
      updates: {
        claude: { ok: false, error: 'the plugin was removed but could not be reinstalled' },
      },
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(stateOf(result, 'claude')).toBe('failed');
    expect(result.steps[0]!.error).toContain('could not be reinstalled');
  });

  it('fails when the thing is gone after updating', async () => {
    // A remove-then-add that removed and did not add leaves nothing installed.
    // An exit code saying otherwise is a claim; the probe is the observation.
    const { runner } = makeRunner({
      checks: { claude: [{ outcome: 'missing' }] },
      installs: {},
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(stateOf(result, 'claude')).toBe('failed');
    expect(result.steps[0]!.error).toMatch(/after updating/i);
  });

  it('keeps saying an update is available when the update silently no-ops', async () => {
    // The version did not move, so the fresh probe still finds one newer. The
    // row must keep offering it rather than reporting a success that never
    // happened.
    const { runner } = makeRunner({
      checks: {
        claude: [
          { outcome: 'satisfied', version: '2.1.0', latestVersion: '2.2.0', updateAvailable: true },
        ],
      },
      installs: {},
    });

    const result = await runner.updateStep(plan([installed()]), 'claude');

    expect(stateOf(result, 'claude')).toBe('satisfied');
    expect(result.steps[0]!.updateAvailable).toBe(true);
  });

  it('refuses to run while another operation holds the host', async () => {
    const { runner } = makeRunner({
      checks: { claude: [{ outcome: 'satisfied', version: '2.2.0' }] },
      installs: {},
    });
    const p = plan([installed(), step('git')]);

    const first = runner.updateStep(p, 'claude');
    await expect(runner.updateStep(p, 'claude')).rejects.toThrow(/already running/i);
    await first;
  });

  it('aborts as unreachable rather than blaming the dependency', async () => {
    const { runner, updateOrder } = makeRunner({
      checks: {},
      installs: {},
      reachable: false,
    });

    await expect(runner.updateStep(plan([installed()]), 'claude')).rejects.toBeInstanceOf(
      HostSetupAbortedError
    );
    expect(updateOrder).toEqual([]);
  });
});
