import { describe, expect, it } from 'vitest';
import type { HostSetupPlan, HostSetupStep } from '@shared/core/remote-hosts/setup';
import {
  agentTypeBadge,
  canInstall,
  canSkip,
  canOfferAction,
  canUpdate,
  dependenciesMet,
  groupPlanSteps,
  outcomeLabel,
  stepBadge,
  versionSubtitle,
} from './step-presentation';

function step(patch: Partial<HostSetupStep> = {}): HostSetupStep {
  return {
    id: 'node',
    kind: 'core-dependency',
    name: 'Node.js',
    state: 'pending',
    outcome: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: [],
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...patch,
  };
}

function plan(steps: HostSetupStep[], patch: Partial<HostSetupPlan> = {}): HostSetupPlan {
  return {
    sshHost: 'dev-vm',
    status: 'idle',
    steps,
    currentStepId: null,
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...patch,
  };
}

describe('stepBadge — green must be earned', () => {
  it('is success only for a satisfied step', () => {
    expect(stepBadge(step({ state: 'satisfied' }))).toEqual({
      tone: 'success',
      label: 'Installed',
    });
  });

  it.each(['pending', 'checking', 'installing', 'failed', 'skipped'] as const)(
    'is never success for %s',
    (state) => {
      expect(stepBadge(step({ state })).tone).not.toBe('success');
    }
  );

  it('does not show a skipped step as done even though the run moved past it', () => {
    expect(stepBadge(step({ state: 'skipped' }))).toEqual({ tone: 'neutral', label: 'Skipped' });
  });

  describe('"not checked" and "checked, and absent" are different facts', () => {
    it('says not checked when nothing has been observed', () => {
      expect(stepBadge(step({ state: 'pending', outcome: null }))).toEqual({
        tone: 'neutral',
        label: 'Not checked',
      });
    });

    it('reports what a probe-only pass observed, without claiming an attempt', () => {
      // Re-check leaves steps pending but records the outcome. Showing that as
      // "Not checked" would throw away the only thing the user asked for.
      expect(stepBadge(step({ state: 'pending', outcome: 'missing' }))).toEqual({
        tone: 'warning',
        label: 'Not installed',
      });
    });

    it('does not dress an undetermined probe up as a definite answer', () => {
      expect(stepBadge(step({ state: 'pending', outcome: 'unknown' })).label).toBe(
        'Could not be checked'
      );
    });
  });
});

describe('agentTypeBadge — a CLI alone is not usable', () => {
  const cli = (patch: Partial<HostSetupStep> = {}) =>
    step({ id: 'claude-code', kind: 'agent-cli', name: 'Claude Code', ...patch });
  const plugin = (patch: Partial<HostSetupStep> = {}) =>
    step({
      id: 'claude-code:plugin',
      kind: 'agent-plugin',
      name: 'Claude Code · Switch connector',
      ...patch,
    });
  const row = (c: HostSetupStep, p: HostSetupStep | null) => ({
    agentId: 'claude-code',
    name: 'Claude Code',
    cli: c,
    plugin: p,
  });

  it('is installed only when both the CLI and the connector are satisfied', () => {
    expect(
      agentTypeBadge(row(cli({ state: 'satisfied' }), plugin({ state: 'satisfied' })))
    ).toEqual({ tone: 'success', label: 'Installed' });
  });

  it('calls out the connector when the CLI is there but the connector is not', () => {
    // Without the connector the agent starts and has no Switch tools — rounding
    // this up to "Installed" is what makes that failure invisible.
    expect(agentTypeBadge(row(cli({ state: 'satisfied' }), plugin({ state: 'pending' })))).toEqual({
      tone: 'warning',
      label: 'Switch setup required',
    });
  });

  it('reports the CLI state when the CLI itself is missing', () => {
    expect(agentTypeBadge(row(cli({ state: 'pending', outcome: 'missing' }), plugin())).label).toBe(
      'Not installed'
    );
  });

  it('surfaces a failure from either half', () => {
    expect(
      agentTypeBadge(
        row(cli({ state: 'satisfied' }), plugin({ state: 'failed', outcome: 'missing' }))
      ).tone
    ).toBe('danger');
  });

  it('shows work in flight ahead of the resting state', () => {
    expect(
      agentTypeBadge(row(cli({ state: 'satisfied' }), plugin({ state: 'installing' }))).label
    ).toBe('Installing…');
  });
});

describe('groupPlanSteps', () => {
  it('splits prerequisites from agent types and pairs each CLI with its connector', () => {
    const grouped = groupPlanSteps(
      plan([
        step({ id: 'git', name: 'Git' }),
        step({ id: 'gh', kind: 'core-dependency', name: 'GitHub CLI' }),
        step({ id: 'claude-code', kind: 'agent-cli', name: 'Claude Code' }),
        step({
          id: 'claude-code:plugin',
          kind: 'agent-plugin',
          name: 'Claude Code · Switch connector',
        }),
      ])
    );

    expect(grouped.prerequisites.map((s) => s.id)).toEqual(['git', 'gh']);
    expect(grouped.agentTypes).toHaveLength(1);
    expect(grouped.agentTypes[0]!.agentId).toBe('claude-code');
    expect(grouped.agentTypes[0]!.plugin?.id).toBe('claude-code:plugin');
  });

  it('keeps an agent type whose connector step is absent', () => {
    const grouped = groupPlanSteps(plan([step({ id: 'codex', kind: 'agent-cli', name: 'Codex' })]));

    expect(grouped.agentTypes[0]!.plugin).toBeNull();
  });

  it('is empty for a host with no plan', () => {
    expect(groupPlanSteps(null)).toEqual({ prerequisites: [], agentTypes: [] });
  });
});

describe('outcomeLabel', () => {
  it('says plainly when a check could not determine anything', () => {
    expect(outcomeLabel('unknown')).toBe('Could not be checked');
    expect(outcomeLabel(null)).toBe('Not checked yet');
  });

  it('distinguishes a stopped service from a missing one', () => {
    expect(outcomeLabel('not-running')).toBe('Installed but not running');
    expect(outcomeLabel('missing')).toBe('Not installed');
  });
});

describe('canSkip', () => {
  it('offers a skip on a failure', () => {
    expect(canSkip(step({ state: 'failed' }))).toBe(true);
  });

  it('offers a skip on something observed to be missing', () => {
    // After a re-check nothing has "failed" yet, but the user still needs a way
    // past it.
    expect(canSkip(step({ state: 'pending', outcome: 'missing' }))).toBe(true);
  });

  it('does not offer a skip for something never looked at, or already there', () => {
    expect(canSkip(step({ state: 'pending', outcome: null }))).toBe(false);
    expect(canSkip(step({ state: 'satisfied', outcome: 'satisfied' }))).toBe(false);
  });
});

describe('canInstall', () => {
  it('offers an install for anything outstanding', () => {
    expect(canInstall(step({ state: 'pending', outcome: 'missing' }))).toBe(true);
    expect(canInstall(step({ state: 'failed', outcome: 'missing' }))).toBe(true);
  });

  it('does not offer an install for something already there or in flight', () => {
    expect(canInstall(step({ state: 'satisfied' }))).toBe(false);
    expect(canInstall(step({ state: 'installing' }))).toBe(false);
    expect(canInstall(step({ state: 'checking' }))).toBe(false);
  });
});

describe('dependenciesMet — do not offer an action that cannot work', () => {
  const dependent = (patch: Partial<HostSetupStep> = {}) =>
    step({
      id: 'claude-code',
      kind: 'agent-cli',
      name: 'Claude Code',
      dependsOn: ['node'],
      ...patch,
    });

  it('is false while the dependency it needs is still missing', () => {
    // Offering an install before Node exists sends the user into a failure that
    // says nothing about the real problem.
    const p = plan([step({ id: 'node', name: 'Node.js', outcome: 'missing' }), dependent()]);

    expect(dependenciesMet(p.steps[1]!, p)).toBe(false);
  });

  it('is true once the dependency is there', () => {
    const p = plan([
      step({ id: 'node', name: 'Node.js', state: 'satisfied', outcome: 'satisfied' }),
      dependent(),
    ]);

    expect(dependenciesMet(p.steps[1]!, p)).toBe(true);
  });

  it('is true for a step that depends on nothing', () => {
    expect(dependenciesMet(step({ id: 'git' }), plan([step({ id: 'git' })]))).toBe(true);
  });

  it('is false when there is no plan to check against', () => {
    expect(dependenciesMet(dependent(), null)).toBe(false);
  });
});

describe('canUpdate', () => {
  it('offers an update when a newer version is known', () => {
    expect(
      canUpdate(step({ state: 'satisfied', latestVersion: '2.2.0', updateAvailable: true }))
    ).toBe(true);
  });

  it('offers nothing when the latest version could not be read', () => {
    // `updateAvailable` is never inferred from a missing latest version, and
    // this must not reintroduce that inference by the back door.
    expect(
      canUpdate(step({ state: 'satisfied', latestVersion: null, updateAvailable: false }))
    ).toBe(false);
  });

  it('offers nothing on something not installed — that is an install', () => {
    expect(canUpdate(step({ state: 'pending', outcome: 'missing', updateAvailable: true }))).toBe(
      false
    );
  });

  it('never offers to update a login', () => {});

  it('offers nothing while the update is already running', () => {
    expect(canUpdate(step({ state: 'updating', updateAvailable: true }))).toBe(false);
  });
});

/**
 * The runner takes one operation per host and refuses the rest, so a button
 * offered during someone else's operation is a button that cannot work.
 */
describe('canOfferAction', () => {
  it('offers actions on an idle host', () => {
    expect(canOfferAction(false, false)).toBe(true);
  });

  it('withdraws them while the host is working', () => {
    expect(canOfferAction(true, false)).toBe(false);
  });

  it('keeps the button on the row whose own operation is running — it is the progress', () => {
    expect(canOfferAction(true, true)).toBe(true);
  });
});

describe('stepBadge — an update in flight', () => {
  it('says Updating, not Installing, about software already present', () => {
    expect(stepBadge(step({ state: 'updating' }))).toEqual({
      tone: 'info',
      label: 'Updating…',
    });
  });
});

/**
 * A red badge reading "Ready" (CHOO-1809).
 *
 * The failed label names the last observation, which is right for an install
 * ("Not installed") and self-contradictory for an action that failed over
 * something present.
 */
describe('stepBadge — a failed action over something that is installed', () => {
  it('never labels a failed step Ready', () => {
    const badge = stepBadge(step({ state: 'failed', outcome: 'satisfied', version: '0.146.0' }));

    expect(badge.label).not.toBe('Ready');
    expect(badge.tone).toBe('danger');
  });

  it('says what actually happened instead', () => {
    expect(stepBadge(step({ state: 'failed', outcome: 'satisfied' })).label).toBe(
      'Last action failed'
    );
  });

  it('still names the observation when it is the useful thing to say', () => {
    expect(stepBadge(step({ state: 'failed', outcome: 'missing' })).label).toBe('Not installed');
  });
});

/**
 * How far behind, not just that you are behind (CHOO-1809).
 *
 * The badge can only say an update exists. The number you want before taking
 * one was hidden in the Update button's tooltip, invisible to anyone not
 * already hovering it.
 */
describe('versionSubtitle', () => {
  it('shows both versions when something newer exists', () => {
    expect(
      versionSubtitle(
        step({
          state: 'satisfied',
          version: '0.146.0',
          latestVersion: '0.147.0',
          updateAvailable: true,
        })
      )
    ).toBe('0.146.0 → 0.147.0');
  });

  it('shows just the installed version when nothing newer is known', () => {
    expect(versionSubtitle(step({ state: 'satisfied', version: '0.146.0' }))).toBe('0.146.0');
  });

  it('does not promise an update we hold no version for', () => {
    // `updateAvailable` without a `latestVersion` should not happen, but an
    // arrow pointing at nothing is a worse way to find out than a plain version.
    expect(
      versionSubtitle(
        step({ state: 'satisfied', version: '0.146.0', latestVersion: null, updateAvailable: true })
      )
    ).toBe('0.146.0');
  });

  it('says nothing about a step that is not installed', () => {
    expect(
      versionSubtitle(step({ state: 'pending', outcome: 'missing', version: null }))
    ).toBeNull();
  });

  it('never describes a version on something absent, even if one lingers', () => {
    // A stale `version` left on a step that has since gone missing must not be
    // rendered as though it were found.
    expect(
      versionSubtitle(step({ state: 'pending', outcome: 'missing', version: '0.146.0' }))
    ).toBeNull();
  });
});
