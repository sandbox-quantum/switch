import { isStepInFlight, type HostSetupPlan } from '@shared/core/remote-hosts/setup';

/**
 * Remembers what each host's setup steps last settled on, and says when a
 * plan settles one differently.
 *
 * A plan is pushed on every transition, "checking" and "installing" included,
 * so reacting to each push would repeat whatever follows it several times per
 * step. Only a finished check, install or update that found something new —
 * Claude Code going from not installed to installed — counts.
 */
export class SettledStepTracker {
  private readonly seen = new Map<string, Map<string, string>>();

  /** Whether `plan` settles a step differently from the last plan seen for its host. */
  changed(plan: HostSetupPlan): boolean {
    let known = this.seen.get(plan.sshHost);
    if (!known) {
      known = new Map();
      this.seen.set(plan.sshHost, known);
    }
    let changed = false;
    for (const step of plan.steps) {
      if (isStepInFlight(step)) continue;
      const result = `${step.state}|${step.outcome ?? ''}|${step.version ?? ''}`;
      if (known.get(step.id) !== result) changed = true;
      known.set(step.id, result);
    }
    return changed;
  }
}
