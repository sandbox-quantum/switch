import { describe, expect, it } from 'vitest';
import { deriveAgentTypeStatus, deriveHostStatus, isHostUsable } from './host-status';
import type { HostReachability, HostReachabilityStatus } from './reachability';
import type { HostSetupPlan, HostSetupStep, HostSetupStepKind, HostSetupStepState } from './setup';

function reachability(status: HostReachabilityStatus): HostReachability {
  return {
    sshHost: 'dev-vm',
    status,
    lastError: null,
    lastCheckedAt: null,
    lastReachableAt: null,
    consecutiveFailures: 0,
    nextProbeAt: null,
    probing: false,
  };
}

function step(
  id: string,
  state: HostSetupStepState,
  optional = false,
  kind: HostSetupStepKind = 'core-dependency'
): HostSetupStep {
  return {
    id,
    kind,
    name: id,
    state,
    outcome: state === 'satisfied' ? 'satisfied' : null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional,
    dependsOn: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function plan(steps: HostSetupStep[], patch: Partial<HostSetupPlan> = {}): HostSetupPlan {
  return {
    sshHost: 'dev-vm',
    status: 'idle',
    steps,
    currentStepId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('deriveHostStatus', () => {
  it('reports a fully satisfied reachable host as ready', () => {
    const status = deriveHostStatus(
      reachability('reachable'),
      plan([step('git', 'satisfied'), step('node', 'satisfied')])
    );

    expect(status.kind).toBe('ready');
    expect(status.done).toBe(2);
    expect(isHostUsable(status)).toBe(true);
  });

  it('does not hold an outstanding optional step against the verdict', () => {
    const status = deriveHostStatus(
      reachability('reachable'),
      plan([step('git', 'satisfied'), step('gh', 'pending', true)])
    );

    expect(status.kind).toBe('ready');
  });

  it('counts every step shown, so the tally cannot contradict the list', () => {
    // A count that quietly excluded optional steps is how a host came to read
    // "5 of 5 required" with two rows plainly saying Not installed.
    const status = deriveHostStatus(
      reachability('reachable'),
      plan([step('git', 'satisfied'), step('gh', 'pending', true)])
    );

    expect(status.done).toBe(1);
    expect(status.total).toBe(2);
  });

  describe('readiness is withheld when the host cannot be reached', () => {
    // The whole point of CHOO-1780: a network problem must not be reported as
    // a missing dependency, however good or bad the last setup run looked.
    it('reports unreachable, not setup-required, even with a failed plan', () => {
      const status = deriveHostStatus(
        reachability('unreachable'),
        plan([step('git', 'failed'), step('node', 'pending')])
      );

      expect(status.kind).toBe('unreachable');
      expect(status.readinessKnown).toBe(false);
      expect(isHostUsable(status)).toBe(false);
    });

    it('reports unreachable, not ready, even with a fully satisfied plan', () => {
      const status = deriveHostStatus(
        reachability('unreachable'),
        plan([step('git', 'satisfied')])
      );

      expect(status.kind).toBe('unreachable');
      expect(status.readinessKnown).toBe(false);
      expect(isHostUsable(status)).toBe(false);
    });

    it('distinguishes an auth failure, which never self-heals', () => {
      const status = deriveHostStatus(reachability('suspended'), null);

      expect(status.kind).toBe('auth-failed');
      expect(status.label).toBe('SSH auth failed');
    });
  });

  describe('not knowing is its own answer', () => {
    it('reports a host with no plan as unchecked, not as not-ready', () => {
      const status = deriveHostStatus(reachability('reachable'), null);

      expect(status.kind).toBe('unchecked');
      expect(status.readinessKnown).toBe(false);
    });

    it('reports a built-but-never-observed plan as unchecked', () => {
      // Building the plan lists what to check; it observes nothing. Calling
      // that "setup required" claims knowledge we do not have.
      const status = deriveHostStatus(
        reachability('reachable'),
        plan([step('git', 'pending'), step('node', 'pending')])
      );

      expect(status.kind).toBe('unchecked');
      expect(status.readinessKnown).toBe(false);
    });

    it('reports setup-required once something has actually been observed', () => {
      const status = deriveHostStatus(
        reachability('reachable'),
        plan([step('git', 'satisfied'), step('node', 'pending')])
      );

      expect(status.kind).toBe('setup-required');
      expect(status.readinessKnown).toBe(true);
      expect(status.done).toBe(1);
      expect(status.total).toBe(2);
    });

    it('treats an unknown-reachability host as checkable rather than blocked', () => {
      // `unknown` is deliberately not blocking elsewhere in the app; readiness
      // should follow the same convention.
      const status = deriveHostStatus(reachability('unknown'), plan([step('git', 'satisfied')]));

      expect(status.kind).toBe('ready');
    });
  });

  it('names the step in flight while an install is going', () => {
    const status = deriveHostStatus(
      reachability('reachable'),
      plan([step('git', 'satisfied'), step('node', 'installing')])
    );

    expect(status.kind).toBe('setting-up');
    expect(status.label).toBe('Setting up node…');
  });

  it('reports a skipped required step as still not ready', () => {
    // Skipping is the user moving past a problem, not the problem going away.
    const status = deriveHostStatus(reachability('reachable'), plan([step('git', 'skipped')]));

    expect(status.kind).toBe('setup-required');
    expect(isHostUsable(status)).toBe(false);
  });

  describe('the host is judged on its own prerequisites, not its agent types', () => {
    // A host with every prerequisite installed is ready. One of several agent
    // CLIs being absent is that type's problem, not the machine's — conflating
    // the two is what made a fully-provisioned host read "Setup required".
    const hostReadyCodexMissing = () =>
      plan([
        step('git', 'satisfied'),
        step('node', 'satisfied'),
        step('claude', 'satisfied', false, 'agent-cli'),
        step('claude:plugin', 'satisfied', false, 'agent-plugin'),
        step('codex', 'pending', false, 'agent-cli'),
        step('codex:plugin', 'pending', false, 'agent-plugin'),
      ]);

    it('reports ready when only an agent CLI is missing', () => {
      const status = deriveHostStatus(reachability('reachable'), hostReadyCodexMissing());

      expect(status.kind).toBe('ready');
      expect(isHostUsable(status)).toBe(true);
    });

    it('counts only the host prerequisites, so the tally matches that section', () => {
      const status = deriveHostStatus(reachability('reachable'), hostReadyCodexMissing());

      expect(status.done).toBe(2);
      expect(status.total).toBe(2);
    });

    it('is not distracted by an agent CLI installing elsewhere on the host', () => {
      const status = deriveHostStatus(
        reachability('reachable'),
        plan([step('git', 'satisfied'), step('codex', 'installing', false, 'agent-cli')])
      );

      expect(status.kind).toBe('ready');
    });
  });
});

describe('deriveAgentTypeStatus', () => {
  /** A step we have actually looked at and found absent. */
  function observedMissing(id: string, kind: HostSetupStepKind): HostSetupStep {
    return { ...step(id, 'pending', false, kind), outcome: 'missing' };
  }

  const twoAgentTypes = () =>
    plan([
      step('git', 'satisfied'),
      step('claude', 'satisfied', false, 'agent-cli'),
      step('claude:plugin', 'satisfied', false, 'agent-plugin'),
      observedMissing('codex', 'agent-cli'),
      observedMissing('codex:plugin', 'agent-plugin'),
    ]);

  it('reports an installed type as ready', () => {
    const status = deriveAgentTypeStatus(reachability('reachable'), twoAgentTypes(), 'claude');

    expect(status.kind).toBe('ready');
  });

  it('reports a missing type as setup-required', () => {
    const status = deriveAgentTypeStatus(reachability('reachable'), twoAgentTypes(), 'codex');

    expect(status.kind).toBe('setup-required');
    expect(status.done).toBe(0);
    expect(status.total).toBe(2);
  });

  it('reports a type nobody has looked at as unchecked, not missing', () => {
    // Per type, the same rule the host verdict follows: a plan lists what to
    // check and observes nothing, so calling an unobserved type "setup
    // required" claims knowledge we have not earned.
    const status = deriveAgentTypeStatus(
      reachability('reachable'),
      plan([
        step('git', 'satisfied'),
        step('codex', 'pending', false, 'agent-cli'),
        step('codex:plugin', 'pending', false, 'agent-plugin'),
      ]),
      'codex'
    );

    expect(status.kind).toBe('unchecked');
    expect(status.readinessKnown).toBe(false);
  });

  it('inherits the host verdict when the host itself is not ready', () => {
    // Every type is blocked by a missing prerequisite, and saying "Codex is
    // missing" of a host with no node would name the wrong cause.
    const status = deriveAgentTypeStatus(
      reachability('reachable'),
      plan([step('node', 'pending'), step('git', 'satisfied')]),
      'codex'
    );

    expect(status.kind).toBe('setup-required');
    expect(status.total).toBe(2);
  });

  it('withholds a verdict for an unreachable host rather than blaming the type', () => {
    const status = deriveAgentTypeStatus(reachability('unreachable'), twoAgentTypes(), 'codex');

    expect(status.kind).toBe('unreachable');
    expect(status.readinessKnown).toBe(false);
  });

  it('falls back to the host verdict for a type with no steps in the plan', () => {
    const status = deriveAgentTypeStatus(reachability('reachable'), twoAgentTypes(), 'mistral');

    expect(status.kind).toBe('ready');
  });

  it('falls back to the host verdict when no type has been chosen', () => {
    const status = deriveAgentTypeStatus(reachability('reachable'), twoAgentTypes(), null);

    expect(status.kind).toBe('ready');
  });

  it('names the agent step in flight while its install runs', () => {
    const status = deriveAgentTypeStatus(
      reachability('reachable'),
      plan([step('git', 'satisfied'), step('codex', 'installing', false, 'agent-cli')]),
      'codex'
    );

    expect(status.kind).toBe('setting-up');
    expect(status.label).toBe('Setting up codex…');
  });
});
