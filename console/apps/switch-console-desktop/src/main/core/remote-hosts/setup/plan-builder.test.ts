import { describe, expect, it } from 'vitest';
import { CORE_DEPENDENCIES } from '@main/core/dependencies/core-dependencies';
import { listPlugins } from '@main/core/providers/plugin-registry';
import { deriveHostStatus } from '@shared/core/remote-hosts/host-status';
import type { HostReachability } from '@shared/core/remote-hosts/reachability';
import type { HostSetupPlan, HostSetupStep } from '@shared/core/remote-hosts/setup';
import { agentPluginStepId, buildSetupPlan, reconcileInterruptedPlan } from './plan-builder';

const NOW = '2026-02-02T00:00:00.000Z';

const CORE = [
  { id: 'git', name: 'Git' },
  { id: 'node', name: 'Node.js' },
  { id: 'tmux', name: 'tmux' },
  { id: 'gh', name: 'GitHub CLI' },
];
const AGENTS = [{ agentId: 'claude-code', name: 'Claude Code' }];

function build(existing: HostSetupPlan | null = null) {
  return buildSetupPlan({
    sshHost: 'dev-vm',
    coreDependencies: CORE,
    agentTypes: AGENTS,
    existing,
    now: NOW,
  });
}

describe('buildSetupPlan', () => {
  it('orders core tools first, then each agent CLI before its plugin', () => {
    expect(build().steps.map((s) => s.id)).toEqual([
      'git',
      'node',
      'tmux',
      'gh',
      'claude-code',
      agentPluginStepId('claude-code'),
    ]);
  });

  it('leaves every core tool required, so none can strand a host silently', () => {
    const plan = build();
    const optional = plan.steps.filter((s) => s.optional).map((s) => s.id);
    expect(optional).toEqual([]);
  });

  it('keeps the required core tools required', () => {
    const plan = build();
    for (const id of ['git', 'node', 'tmux']) {
      expect(plan.steps.find((s) => s.id === id)!.optional).toBe(false);
    }
  });

  it('declares that agent CLIs need node, since they install via npm', () => {
    const cli = build().steps.find((s) => s.id === 'claude-code')!;
    expect(cli.dependsOn).toContain('node');
  });

  it('declares that a plugin needs its own CLI', () => {
    const plugin = build().steps.find((s) => s.id === agentPluginStepId('claude-code'))!;
    expect(plugin.dependsOn).toEqual(['claude-code']);
  });

  it('starts every step pending with no outcome', () => {
    for (const step of build().steps) {
      expect(step.state).toBe('pending');
      expect(step.outcome).toBeNull();
    }
  });

  it('assigns the right kind to each step', () => {
    const kinds = Object.fromEntries(build().steps.map((s) => [s.id, s.kind]));
    expect(kinds.git).toBe('core-dependency');
    expect(kinds['claude-code']).toBe('agent-cli');
    expect(kinds[agentPluginStepId('claude-code')]).toBe('agent-plugin');
  });
});

describe('buildSetupPlan — rebuilding onto an existing plan', () => {
  function existingPlan(steps: Partial<HostSetupStep>[]): HostSetupPlan {
    return {
      sshHost: 'dev-vm',
      status: 'idle',
      currentStepId: 'node',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      steps: steps.map((patch) => ({
        id: 'x',
        kind: 'core-dependency',
        name: 'x',
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
      })) as HostSetupStep[],
    };
  }

  it('preserves progress rather than discarding it', () => {
    const plan = build(
      existingPlan([
        { id: 'git', state: 'satisfied', outcome: 'satisfied', version: '2.43.0' },
        { id: 'node', state: 'failed', outcome: 'missing', error: 'apt failed', output: 'E:' },
      ])
    );

    const git = plan.steps.find((s) => s.id === 'git')!;
    expect(git.state).toBe('satisfied');
    expect(git.version).toBe('2.43.0');

    const node = plan.steps.find((s) => s.id === 'node')!;
    expect(node.state).toBe('failed');
    expect(node.error).toBe('apt failed');
    expect(node.output).toBe('E:');
  });

  it('adds newly known steps as pending without touching the rest', () => {
    const plan = build(existingPlan([{ id: 'git', state: 'satisfied', outcome: 'satisfied' }]));

    expect(plan.steps.find((s) => s.id === 'git')!.state).toBe('satisfied');
    expect(plan.steps.find((s) => s.id === 'claude-code')!.state).toBe('pending');
  });

  it('drops steps that are no longer known', () => {
    const plan = build(existingPlan([{ id: 'retired-agent', state: 'satisfied' }]));
    expect(plan.steps.some((s) => s.id === 'retired-agent')).toBe(false);
  });

  it('keeps the original creation time and the halted status', () => {
    const plan = build(existingPlan([{ id: 'git', state: 'satisfied' }]));
    expect(plan.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(plan.status).toBe('idle');
    expect(plan.currentStepId).toBe('node');
  });

  it('re-imposes canonical order even if the stored order differed', () => {
    const plan = build(
      existingPlan([
        { id: 'tmux', state: 'satisfied' },
        { id: 'git', state: 'satisfied' },
      ])
    );
    expect(plan.steps.map((s) => s.id).slice(0, 3)).toEqual(['git', 'node', 'tmux']);
  });
});

describe('reconcileInterruptedPlan', () => {
  function planWith(state: HostSetupStep['state'], status: HostSetupPlan['status']): HostSetupPlan {
    return {
      sshHost: 'dev-vm',
      status,
      currentStepId: 'node',
      createdAt: NOW,
      updatedAt: NOW,
      steps: [
        {
          id: 'git',
          kind: 'core-dependency',
          name: 'Git',
          state: 'satisfied',
          outcome: 'satisfied',
          version: '2.43.0',
          latestVersion: null,
          updateAvailable: false,
          error: null,
          output: null,
          optional: false,
          dependsOn: [],
          updatedAt: NOW,
        },
        {
          id: 'node',
          kind: 'core-dependency',
          name: 'Node.js',
          state,
          outcome: null,
          version: null,
          latestVersion: null,
          updateAvailable: false,
          error: null,
          output: null,
          optional: false,
          dependsOn: [],
          updatedAt: NOW,
        },
      ],
    };
  }

  it('resets a step the app died mid-install on — never to satisfied', () => {
    const reconciled = reconcileInterruptedPlan(planWith('installing', 'idle'), NOW);
    const node = reconciled.steps.find((s) => s.id === 'node')!;
    expect(node.state).toBe('pending');
    expect(node.outcome).toBeNull();
  });

  it('resets a step interrupted mid-check', () => {
    const reconciled = reconcileInterruptedPlan(planWith('checking', 'idle'), NOW);
    expect(reconciled.steps.find((s) => s.id === 'node')!.state).toBe('pending');
  });

  it('clears a stale running status so the plan is startable again', () => {
    expect(reconcileInterruptedPlan(planWith('installing', 'idle'), NOW).status).toBe('idle');
  });

  it('leaves genuinely finished work alone', () => {
    const reconciled = reconcileInterruptedPlan(planWith('installing', 'idle'), NOW);
    const git = reconciled.steps.find((s) => s.id === 'git')!;
    expect(git.state).toBe('satisfied');
    expect(git.version).toBe('2.43.0');
  });

  it('is a no-op for a cleanly halted plan', () => {
    const plan = planWith('failed', 'idle');
    expect(reconcileInterruptedPlan(plan, NOW)).toBe(plan);
  });
});

/**
 * Every other test here builds from fixtures, which is exactly why the Codex
 * regression got through: making Codex Switch-supported added two required
 * steps to every real plan, and nothing built from the real registry to notice.
 * These tests use the shipped dependency list and plugin registry, so adding an
 * agent type that quietly changes what a provisioned host reports fails here.
 */
describe('buildSetupPlan — against the real registry', () => {
  const reachable: HostReachability = {
    sshHost: 'dev-vm',
    status: 'reachable',
    lastError: null,
    lastCheckedAt: null,
    lastReachableAt: null,
    consecutiveFailures: 0,
    nextProbeAt: null,
    probing: false,
  };

  /** The same filter `plannableAgentTypes` applies before building a plan. */
  const switchSupported = () =>
    listPlugins()
      .filter((plugin) => plugin.capabilities.switchSetup.kind === 'cli')
      .map((plugin) => ({ agentId: plugin.metadata.id, name: plugin.metadata.id }));

  const realPlan = () =>
    buildSetupPlan({
      sshHost: 'dev-vm',
      coreDependencies: CORE_DEPENDENCIES.map((dep) => ({ id: dep.id, name: dep.name })),
      agentTypes: switchSupported(),
      existing: null,
      now: NOW,
    });

  function satisfy(plan: HostSetupPlan, predicate: (step: HostSetupStep) => boolean) {
    return {
      ...plan,
      steps: plan.steps.map((step) =>
        predicate(step)
          ? { ...step, state: 'satisfied' as const, outcome: 'satisfied' as const }
          : step
      ),
    };
  }

  it('offers more than one Switch-supported agent type', () => {
    // Guards the premise of the test below: with a single type, host-wide and
    // per-type verdicts coincide and the regression is invisible.
    expect(switchSupported().length).toBeGreaterThan(1);
  });

  it('reports a host with every prerequisite installed as ready, whatever agent types ship', () => {
    // The reported bug: all prerequisites present, one agent CLI absent, and the
    // host badge read "Setup required".
    const plan = satisfy(realPlan(), (step) => step.kind === 'core-dependency');

    expect(deriveHostStatus(reachable, plan).kind).toBe('ready');
  });

  it('still reports a host missing a prerequisite as not ready', () => {
    // The inverse, so the test above cannot pass by never blocking anything.
    const plan = satisfy(
      realPlan(),
      (step) => step.kind === 'core-dependency' && step.id !== 'node'
    );

    expect(deriveHostStatus(reachable, plan).kind).toBe('setup-required');
  });
});
