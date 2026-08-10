/**
 * Setup operations for a remote host (CHOO-1809).
 *
 * Every operation here is one the user asked for explicitly: check everything,
 * install this one thing, skip this one thing. There is deliberately no
 * run-the-whole-plan loop — the ordering in a plan is guidance for a person,
 * not a script. Three rules drive the design:
 *
 * 1. **One thing at a time.** Nothing runs concurrently against a host; a
 *    second request while one is in flight is refused rather than interleaved.
 *    The old page fired every probe and install independently and left the user
 *    to guess the sequence.
 * 2. **Verification is explicit.** After an install we re-check rather than
 *    assuming the installer worked. A step is only `satisfied` on the strength
 *    of a fresh observation — an exit code is a claim.
 * 3. **Reachability is not a dependency verdict.** The reachability gate is
 *    consulted before any probing, and an unreachable host aborts as
 *    *unreachable* instead of reporting every prerequisite as missing.
 */

import {
  isInstallableOutcome,
  isPlanComplete,
  type DependencyCheckOutcome,
  type HostSetupPlan,
  type HostSetupStep,
} from '@shared/core/remote-hosts/setup';

/** What a probe observed for one step. */
export type StepCheckResult = {
  outcome: DependencyCheckOutcome;
  version?: string | null;
  /** Version available to install, when it could be determined. Null = unknown. */
  latestVersion?: string | null;
  /** True only when a newer version is known to exist. */
  updateAvailable?: boolean;
  /** Set when the outcome is `unknown` — why we could not tell. */
  error?: string;
};

/** Outcome of installing one step. */
export type StepInstallResult = { ok: true } | { ok: false; error: string; output?: string | null };

export type HostSetupRunnerDeps = {
  sshHost: string;
  /** Load the persisted plan. Null when the host has never been set up. */
  load: (sshHost: string) => Promise<HostSetupPlan | null>;
  save: (plan: HostSetupPlan) => Promise<void>;
  /** Push the plan to the renderer on every transition. */
  publish: (plan: HostSetupPlan) => void;
  check: (step: HostSetupStep) => Promise<StepCheckResult>;
  install: (step: HostSetupStep) => Promise<StepInstallResult>;
  /** Replace an already-installed step with the newest available version. */
  update: (step: HostSetupStep) => Promise<StepInstallResult>;
  /** Whether this step can be installed by switchdash at all on this host. */
  canInstall: (step: HostSetupStep) => boolean;
  /**
   * Throws when the host is not reachable. Wired to the central reachability
   * service (CHOO-1682/1780) — this runner never forms its own verdict.
   */
  requireReachable: (sshHost: string) => void;
  now?: () => Date;
};

/** Raised when a run is abandoned because the host itself is not reachable. */
export class HostSetupAbortedError extends Error {
  constructor(
    message: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'HostSetupAbortedError';
  }
}

export class HostSetupRunner {
  private running = false;

  constructor(private readonly deps: HostSetupRunnerDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /**
   * Observe every step, installing nothing — what "Re-check" means.
   *
   * A user who wants to know where a host stands should not have to change it
   * to find out. A pass here records what is actually there and leaves
   * unsatisfied steps `pending` — they carry their observed `outcome`, so the
   * UI can say "not installed" rather than "not checked", without claiming an
   * attempt was made.
   *
   * A previous failure's error and command output are cleared deliberately: a
   * fresh observation supersedes the story of an older install attempt.
   */
  async checkAll(plan: HostSetupPlan): Promise<HostSetupPlan> {
    if (this.running) {
      throw new Error(`Another setup operation is already running for ${this.deps.sshHost}`);
    }
    this.running = true;
    try {
      let next = plan;
      for (const step of plan.steps) {
        try {
          this.deps.requireReachable(this.deps.sshHost);
        } catch (error) {
          next = await this.transition(next, { status: 'idle', currentStepId: null });
          throw new HostSetupAbortedError(
            `Could not check ${this.deps.sshHost}: the host became unreachable.`,
            error
          );
        }

        next = await this.patchStep(next, step.id, {
          state: 'checking',
          error: null,
          output: null,
        });
        next = await this.observe(next, step.id);

        if (findStep(next, step.id).state !== 'satisfied') {
          next = await this.patchStep(next, step.id, { state: 'pending' });
        }
      }

      return await this.transition(next, {
        status: isPlanComplete(next) ? 'complete' : 'idle',
        currentStepId: null,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Observe ONE step, installing nothing — the per-item re-check.
   *
   * Same contract as `checkAll`, narrowed to a single step: a user asking "is
   * this still installed?" should not have to re-probe the whole host, which
   * costs an SSH round trip per step. An unsatisfied step is left `pending`
   * carrying its observed outcome, so the row can say "not installed" without
   * claiming an install was attempted.
   */
  async checkStep(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    if (this.running) {
      throw new Error(`Another setup operation is already running for ${this.deps.sshHost}`);
    }
    this.running = true;
    try {
      try {
        this.deps.requireReachable(this.deps.sshHost);
      } catch (error) {
        throw new HostSetupAbortedError(
          `Could not check ${this.deps.sshHost}: the host is not reachable.`,
          error
        );
      }

      let next = await this.patchStep(plan, stepId, {
        state: 'checking',
        error: null,
        output: null,
      });
      next = await this.observe(next, stepId);

      if (findStep(next, stepId).state !== 'satisfied') {
        next = await this.patchStep(next, stepId, { state: 'pending' });
      }

      return await this.transition(next, {
        status: isPlanComplete(next) ? 'complete' : 'idle',
        currentStepId: null,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Install ONE step on its own — the per-item Install button.
   *
   * This is how setup happens: the user sees what a host is missing and fixes
   * one thing. Reachability is checked first and the install is verified after,
   * the same discipline the whole-plan run used to apply.
   */
  async runSingleStep(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    if (this.running) {
      throw new Error(`Another setup operation is already running for ${this.deps.sshHost}`);
    }
    this.running = true;
    try {
      try {
        this.deps.requireReachable(this.deps.sshHost);
      } catch (error) {
        throw new HostSetupAbortedError(
          `Cannot install on ${this.deps.sshHost}: the host is not reachable.`,
          error
        );
      }
      const next = await this.runStep(plan, stepId);
      return await this.transition(next, {
        status: isPlanComplete(next) ? 'complete' : 'idle',
        currentStepId: null,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Replace one already-installed step with the newer version — the Update
   * button (CHOO-1809).
   *
   * Deliberately not folded into `runStep`: that path exists to make an
   * unsatisfied step satisfied, and returns the moment it observes one that
   * already is. Correct for an install, useless for an update.
   *
   * The verification discipline is the same. An updater's exit code is a
   * claim, so the new version is established by a fresh probe. Note what
   * happens if the update silently no-ops: the probe records the same version
   * and `updateAvailable` stays true, so the row keeps saying "Update
   * available" rather than reporting a success that did not happen.
   */
  async updateStep(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    if (this.running) {
      throw new Error(`Another setup operation is already running for ${this.deps.sshHost}`);
    }
    this.running = true;
    try {
      try {
        this.deps.requireReachable(this.deps.sshHost);
      } catch (error) {
        throw new HostSetupAbortedError(
          `Cannot update on ${this.deps.sshHost}: the host is not reachable.`,
          error
        );
      }

      // Refuse rather than run a command whose premise we never established.
      // Without a known newer version there is nothing to update *to*, and the
      // remove-then-add fallback some CLIs use would risk uninstalling a
      // working plugin to reinstall the same one.
      const target = findStep(plan, stepId);
      if (!target.updateAvailable) {
        throw new Error(`No update is known to be available for ${target.name}.`);
      }

      let next = await this.patchStep(plan, stepId, {
        state: 'updating',
        error: null,
        output: null,
      });
      next = await this.transition(next, { currentStepId: stepId });

      const result = await this.deps.update(findStep(next, stepId));
      if (!result.ok) {
        // Look before judging, even on failure. A failed update usually leaves
        // what was there working — but not always: the remove-then-add some
        // CLIs need can remove and then fail to add. Assuming either way gets
        // it wrong half the time, so the state comes from a fresh probe and
        // only the *error* comes from the updater.
        const looking = await this.patchStep(next, stepId, { state: 'checking', error: null });
        const observed = await this.observe(looking, stepId);
        const still = findStep(observed, stepId);
        return await this.settle(
          await this.patchStep(observed, stepId, {
            state: still.outcome === 'satisfied' ? 'satisfied' : 'failed',
            error: result.error,
            output: result.output ?? null,
          })
        );
      }

      const verifying = await this.patchStep(next, stepId, { state: 'checking' });
      const verified = await this.observe(verifying, stepId);
      const after = findStep(verified, stepId);

      if (after.outcome === 'satisfied') return await this.settle(verified);

      return await this.settle(
        await this.patchStep(verified, stepId, {
          state: 'failed',
          error:
            after.outcome === 'unknown'
              ? `${after.name} was updated but could not be verified afterwards.`
              : `${after.name} reports "${after.outcome}" after updating.`,
        })
      );
    } finally {
      this.running = false;
    }
  }

  /** Close out an operation: recompute plan status and clear the current step. */
  private async settle(plan: HostSetupPlan): Promise<HostSetupPlan> {
    return await this.transition(plan, {
      status: isPlanComplete(plan) ? 'complete' : 'idle',
      currentStepId: null,
    });
  }

  /**
   * Check one step, install it if that is both needed and possible, then
   * re-check to verify. Never marks a step satisfied on the strength of an
   * installer's exit code alone.
   */
  async runStep(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    let next = await this.patchStep(plan, stepId, {
      state: 'checking',
      error: null,
      output: null,
    });
    next = await this.transition(next, { currentStepId: stepId });

    const checked = await this.observe(next, stepId);
    const step = findStep(checked, stepId);

    if (step.outcome === 'satisfied') return checked;

    // Nothing we can do automatically — surface the real outcome rather than
    // pretending an install would help. `not-running` and `unknown` land here.
    if (!isInstallableOutcome(step.outcome) || !this.deps.canInstall(step)) {
      return await this.patchStep(checked, stepId, {
        state: 'failed',
        error: describeUnactionable(step),
      });
    }

    const installing = await this.patchStep(checked, stepId, { state: 'installing' });
    const result = await this.deps.install(findStep(installing, stepId));

    if (!result.ok) {
      return await this.patchStep(installing, stepId, {
        state: 'failed',
        error: result.error,
        output: result.output ?? null,
      });
    }

    // Verify. An installer reporting success is a claim, not an observation.
    const verifying = await this.patchStep(installing, stepId, { state: 'checking' });
    const verified = await this.observe(verifying, stepId);
    const after = findStep(verified, stepId);

    if (after.outcome === 'satisfied') return verified;

    return await this.patchStep(verified, stepId, {
      state: 'failed',
      error:
        after.outcome === 'unknown'
          ? `${after.name} was installed but could not be verified afterwards.`
          : `${after.name} still reports "${after.outcome}" after installing.`,
    });
  }

  /** Probe one step and record what was actually observed. */
  private async observe(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    let result: StepCheckResult;
    try {
      result = await this.deps.check(findStep(plan, stepId));
    } catch (error) {
      // A probe that throws tells us nothing about the dependency — record
      // `unknown`, never `missing`.
      result = {
        outcome: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return await this.patchStep(plan, stepId, {
      outcome: result.outcome,
      version: result.version ?? null,
      latestVersion: result.latestVersion ?? null,
      updateAvailable: result.updateAvailable ?? false,
      state: result.outcome === 'satisfied' ? 'satisfied' : 'checking',
      error: result.error ?? null,
    });
  }

  /**
   * Move past a step the user has chosen not to fix. Never reported as
   * satisfied — skipping is a decision to live without something, not evidence
   * that it is there.
   */
  async skip(plan: HostSetupPlan, stepId: string): Promise<HostSetupPlan> {
    const skipped = await this.patchStep(plan, stepId, {
      state: 'skipped',
      error: null,
      output: null,
    });
    return await this.commit({
      ...skipped,
      status: isPlanComplete(skipped) ? 'complete' : 'idle',
    });
  }

  private async patchStep(
    plan: HostSetupPlan,
    stepId: string,
    patch: Partial<Omit<HostSetupStep, 'id'>>
  ): Promise<HostSetupPlan> {
    const steps = plan.steps.map((step) =>
      step.id === stepId ? { ...step, ...patch, updatedAt: this.now() } : step
    );
    return await this.commit({ ...plan, steps });
  }

  private async transition(
    plan: HostSetupPlan,
    patch: Partial<Pick<HostSetupPlan, 'status' | 'currentStepId'>>
  ): Promise<HostSetupPlan> {
    return await this.commit({ ...plan, ...patch });
  }

  /** Persist then publish. Every visible state change goes through here. */
  private async commit(plan: HostSetupPlan): Promise<HostSetupPlan> {
    const next = { ...plan, updatedAt: this.now() };
    await this.deps.save(next);
    this.deps.publish(next);
    return next;
  }
}

function findStep(plan: HostSetupPlan, stepId: string): HostSetupStep {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Setup step ${stepId} is not part of the plan for ${plan.sshHost}`);
  return step;
}

/** Why a step cannot be advanced automatically — stated in terms of what we saw. */
function describeUnactionable(step: HostSetupStep): string {
  // Not a failure of ours to fix: signing in to GitHub is a device flow the
  // user drives in a terminal. Say what they need to do rather than reporting
  // it as a missing install command. A login that exists but lacks a scope
  // says so first — "sign in" reads as wrong advice to someone already signed
  // in, and re-running the flow is nonetheless the fix.
  if (step.kind === 'gh-auth') {
    const prefix = step.error ? `${step.error} ` : '';
    return `${prefix}Signing in to GitHub needs a one-time code you enter yourself. Use Sign in to start it.`;
  }

  switch (step.outcome) {
    case 'not-running':
      return `${step.name} is installed but not running. Start it on the host, then retry.`;
    case 'unknown':
      return step.error ?? `Could not determine whether ${step.name} is available.`;
    case 'wrong-version':
      return `${step.name} is installed but too old, and switchdash has no upgrade command for this host.`;
    default:
      return `${step.name} is not installed, and switchdash has no install command for this host.`;
  }
}
