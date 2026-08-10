import { describe, expect, it } from 'vitest';
import { deriveAgentTypeStatus, type HostStatus } from '@shared/core/remote-hosts/host-status';
import type {
  HostReachability,
  HostReachabilityStatus,
} from '@shared/core/remote-hosts/reachability';
import type {
  HostSetupPlan,
  HostSetupStep,
  HostSetupStepKind,
  HostSetupStepState,
} from '@shared/core/remote-hosts/setup';
import { resolveReadiness, stepsNeedingObservation } from './host-readiness';

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
  kind: HostSetupStepKind = 'core-dependency'
): HostSetupStep {
  return {
    id,
    kind,
    name: id,
    state,
    outcome: state === 'satisfied' ? 'satisfied' : 'missing',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
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

const statusFor = (
  p: HostSetupPlan | null,
  agentId: string | null = null,
  r: HostReachabilityStatus = 'reachable'
): HostStatus => deriveAgentTypeStatus(reachability(r), p, agentId);

describe('resolveReadiness — the agent-creation gate', () => {
  it('blocks a host known to be missing something, and names it', () => {
    const p = plan([step('git', 'pending'), step('node', 'satisfied')]);

    const readiness = resolveReadiness(statusFor(p), p, null, false);

    expect(readiness.blocked).toBe(true);
    expect(readiness.missing).toEqual(['git']);
    expect(readiness.scope).toBe('host');
  });

  it('allows a ready host', () => {
    const p = plan([step('git', 'satisfied')]);

    expect(resolveReadiness(statusFor(p), p, null, false).blocked).toBe(false);
  });

  describe('never block on ignorance', () => {
    it('does not block while a probe is in flight — checking is not a verdict', () => {
      const p = plan([step('git', 'pending'), step('node', 'satisfied')]);

      const readiness = resolveReadiness(statusFor(p), p, null, true);

      expect(readiness.blocked).toBe(false);
      expect(readiness.checking).toBe(true);
    });

    it('does not block a host nobody has ever checked', () => {
      // Refusing here would be the false green inverted: a verdict we did not earn.
      expect(resolveReadiness(statusFor(null), null, null, false).blocked).toBe(false);
    });

    it('does not block a local run, which has no host', () => {
      expect(resolveReadiness(null, null, null, false).blocked).toBe(false);
    });
  });

  it('leaves an unreachable host to the reachability gate rather than calling it not-ready', () => {
    // The modal already refuses unreachable hosts and says something more
    // useful about them; reporting "missing dependencies" here would blame the
    // prerequisites for a network problem.
    const p = plan([step('git', 'pending')]);

    const readiness = resolveReadiness(statusFor(p, null, 'unreachable'), p, null, false);

    expect(readiness.blocked).toBe(false);
  });

  it('counts a skipped required step as still missing', () => {
    const p = plan([step('git', 'skipped')]);

    expect(resolveReadiness(statusFor(p), p, null, false).blocked).toBe(true);
  });

  /**
   * The regression this split exists for: main made Codex a Switch-supported
   * type, which added two required steps to every host, and the single verdict
   * meant a host without Codex refused to create a Claude Code agent that was
   * perfectly well installed.
   */
  describe('the gate judges the agent type being created, not all of them', () => {
    const twoAgentTypes = () =>
      plan([
        step('git', 'satisfied'),
        step('node', 'satisfied'),
        step('claude', 'satisfied', 'agent-cli'),
        step('claude:plugin', 'satisfied', 'agent-plugin'),
        step('codex', 'pending', 'agent-cli'),
        step('codex:plugin', 'pending', 'agent-plugin'),
      ]);

    it('allows creating an agent of an installed type while another type is missing', () => {
      const p = twoAgentTypes();

      const readiness = resolveReadiness(statusFor(p, 'claude'), p, 'claude', false);

      expect(readiness.blocked).toBe(false);
    });

    it('blocks the type that is actually missing, and names only its steps', () => {
      const p = twoAgentTypes();

      const readiness = resolveReadiness(statusFor(p, 'codex'), p, 'codex', false);

      expect(readiness.blocked).toBe(true);
      expect(readiness.scope).toBe('agent-type');
      expect(readiness.missing).toEqual(['codex', 'codex:plugin']);
    });

    it('reports an installed CLI with a missing connector as still not ready', () => {
      // The agent would start and have no Switch tools, which is the stale-green
      // this rewrite exists to remove.
      const p = plan([
        step('git', 'satisfied'),
        step('claude', 'satisfied', 'agent-cli'),
        step('claude:plugin', 'pending', 'agent-plugin'),
      ]);

      const readiness = resolveReadiness(statusFor(p, 'claude'), p, 'claude', false);

      expect(readiness.blocked).toBe(true);
      expect(readiness.scope).toBe('agent-type');
      expect(readiness.missing).toEqual(['claude:plugin']);
    });

    it('blames the host, not the agent type, when a prerequisite is missing', () => {
      // A host with no node cannot install any CLI, so every type inherits that
      // verdict rather than each reporting its own CLI as the problem.
      const p = plan([
        step('git', 'satisfied'),
        step('node', 'pending'),
        step('claude', 'pending', 'agent-cli'),
      ]);

      const readiness = resolveReadiness(statusFor(p, 'claude'), p, 'claude', false);

      expect(readiness.blocked).toBe(true);
      expect(readiness.scope).toBe('host');
      expect(readiness.missing).toEqual(['node']);
    });

    /**
     * Reversed deliberately (CHOO-1809). This previously asserted that a type
     * with no steps was "not held against a ready host", on the reading that
     * there was nothing type-specific to satisfy.
     *
     * That reading was wrong in the direction this whole gate exists to prevent.
     * No steps does not mean nothing to satisfy — it means nobody looked for
     * this type's CLI or its Switch connector. An agent whose connector is
     * absent starts and has no Switch tools, which is precisely the silent
     * failure being designed out. Louis hit it: a host reading Ready let an
     * agent be created for a type that was not set up on it.
     */
    it('refuses a type the plan has never looked for, even on a ready host', () => {
      const p = plan([step('git', 'satisfied')]);

      const readiness = resolveReadiness(statusFor(p, 'mistral'), p, 'mistral', false);

      expect(readiness.blocked).toBe(true);
      expect(readiness.scope).toBe('agent-type');
    });

    it('names nothing as missing when the truth is that nothing was checked', () => {
      // Listing a dependency here would invent a finding. The notice reads off
      // the empty list to say "never checked" rather than "X is missing".
      const p = plan([step('git', 'satisfied')]);

      expect(resolveReadiness(statusFor(p, 'mistral'), p, 'mistral', false).missing).toEqual([]);
    });

    it('still allows a type the plan checked and found complete', () => {
      const p = plan([
        step('git', 'satisfied'),
        step('claude', 'satisfied', 'agent-cli'),
        step('claude:plugin', 'satisfied', 'agent-plugin'),
      ]);

      expect(resolveReadiness(statusFor(p, 'claude'), p, 'claude', false).blocked).toBe(false);
    });
  });
});

/**
 * The persisted plan is the answer most of the time (CHOO-1809).
 *
 * The gate used to re-probe whenever a verdict read `unchecked`, and the probe
 * it ran was a whole-host re-check: picking Codex went and looked at git, tmux,
 * node and Claude Code too. Roughly thirty SSH commands, each opening a login
 * shell, to answer a question about one agent type — which is what made the
 * modal feel slow after changing machines.
 */
describe('stepsNeedingObservation', () => {
  const NOW = Date.parse('2026-08-06T12:00:00.000Z');
  const at = (iso: string, patch: Partial<HostSetupStep> = {}) => ({ ...patch, updatedAt: iso });

  function observed(id: string, iso: string, kind: HostSetupStepKind = 'core-dependency') {
    return { ...step(id, 'satisfied', kind), ...at(iso) };
  }

  it('asks for nothing when everything was seen recently', () => {
    const p = plan([observed('git', '2026-08-06T11:58:00.000Z')]);

    expect(stepsNeedingObservation(p, null, NOW)).toEqual([]);
  });

  it('asks again once an observation is older than the window', () => {
    const p = plan([observed('git', '2026-08-06T11:00:00.000Z')]);

    expect(stepsNeedingObservation(p, null, NOW)).toEqual(['git']);
  });

  it('always asks about a step nobody has ever observed', () => {
    // A fresh timestamp on a step with no outcome is not an observation — the
    // plan was just built.
    const p = plan([
      { ...step('git', 'pending'), outcome: null, updatedAt: '2026-08-06T11:59:00.000Z' },
    ]);

    expect(stepsNeedingObservation(p, null, NOW)).toEqual(['git']);
  });

  it('does not trust a timestamp it cannot read', () => {
    const p = plan([{ ...observed('git', 'not-a-date') }]);

    expect(stepsNeedingObservation(p, null, NOW)).toEqual(['git']);
  });

  it('leaves other agent types alone', () => {
    // The point of the change: choosing Codex must not drag Claude Code's CLI
    // and connector into the probe.
    const p = plan([
      observed('git', '2026-08-06T11:00:00.000Z'),
      observed('claude', '2026-08-06T11:00:00.000Z', 'agent-cli'),
      observed('claude:plugin', '2026-08-06T11:00:00.000Z', 'agent-plugin'),
      observed('codex', '2026-08-06T11:00:00.000Z', 'agent-cli'),
      observed('codex:plugin', '2026-08-06T11:00:00.000Z', 'agent-plugin'),
    ]);

    expect(stepsNeedingObservation(p, 'codex', NOW)).toEqual(['git', 'codex', 'codex:plugin']);
  });

  it('still includes the host prerequisites — they gate every type', () => {
    const p = plan([
      observed('git', '2026-08-06T11:00:00.000Z'),
      observed('codex', '2026-08-06T11:59:00.000Z', 'agent-cli'),
    ]);

    expect(stepsNeedingObservation(p, 'codex', NOW)).toEqual(['git']);
  });

  it('asks for nothing when there is no plan — that is a survey, not a refresh', () => {
    expect(stepsNeedingObservation(null, 'codex', NOW)).toEqual([]);
  });
});
