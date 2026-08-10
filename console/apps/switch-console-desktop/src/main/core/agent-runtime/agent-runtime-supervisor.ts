import type { Pty } from '@main/core/pty/pty';

type AgentSpawnToken = {
  mode: AgentSpawnMode;
  freshRecovery: boolean;
};

type AgentSpawnMode = 'fresh' | 'resume';

type ActiveAgentPty = {
  pty: Pty;
  mode: AgentSpawnMode;
  freshRecovery: boolean;
};

type AgentRuntimeState = {
  desired: boolean;
  active?: ActiveAgentPty;
  spawnInFlight?: AgentSpawnToken;
  consecutiveResumeExits: number;
  recoveryGraceTimer?: ReturnType<typeof setTimeout>;
};

export const MAX_AGENT_RESUME_ATTEMPTS = 1;
export const AGENT_FRESH_RECOVERY_GRACE_MS = 5_000;

export type ExitDecision =
  | { kind: 'stale' }
  | { kind: 'stopped' }
  | { kind: 'failed' }
  | { kind: 'respawnFresh' }
  | { kind: 'respawnResume' };

/**
 * Desired-vs-actual supervisor for the single agent PTY of one session.
 * Owns the crash-recovery ladder: resume → (a resume exit) → fresh →
 * (dies within the startup grace) → fail; a fresh replacement that survives
 * the grace period resets the ladder.
 */
export class AgentRuntimeSupervisor {
  private runtime: AgentRuntimeState | null = null;

  beginStart(
    options: { requireDesired?: boolean; mode?: AgentSpawnMode } = {}
  ): AgentSpawnToken | undefined {
    const runtime = this.getOrCreateRuntime();
    if (runtime.active || runtime.spawnInFlight) return undefined;
    if (options.requireDesired === true && !runtime.desired) return undefined;

    runtime.desired = true;
    const mode = options.mode ?? 'fresh';
    const token = {
      mode,
      freshRecovery:
        mode === 'fresh' && runtime.consecutiveResumeExits >= MAX_AGENT_RESUME_ATTEMPTS,
    };
    runtime.spawnInFlight = token;
    return token;
  }

  acceptSpawn(token: AgentSpawnToken, pty: Pty): boolean {
    const runtime = this.runtime;
    if (!runtime || runtime.spawnInFlight !== token) return false;

    runtime.spawnInFlight = undefined;
    if (!runtime.desired) return false;

    runtime.active = {
      pty,
      mode: token.mode,
      freshRecovery: token.freshRecovery,
    };
    if (token.freshRecovery) {
      this.scheduleRecoveryReset(runtime, pty);
    }
    return true;
  }

  failSpawn(token: AgentSpawnToken): void {
    const runtime = this.runtime;
    if (!runtime || runtime.spawnInFlight !== token) return;
    runtime.spawnInFlight = undefined;
  }

  stop(): Pty | undefined {
    const runtime = this.runtime;
    if (!runtime) return undefined;

    runtime.desired = false;
    runtime.spawnInFlight = undefined;
    this.clearRecoveryGraceTimer(runtime);

    const pty = runtime.active?.pty;
    runtime.active = undefined;
    runtime.consecutiveResumeExits = 0;
    return pty;
  }

  isDesired(): boolean {
    return this.runtime?.desired === true;
  }

  handleExit(pty: Pty): ExitDecision {
    const runtime = this.runtime;
    if (!runtime || runtime.active?.pty !== pty) return { kind: 'stale' };

    const exitedMode = runtime.active.mode;
    const freshRecovery = runtime.active.freshRecovery;
    runtime.active = undefined;
    runtime.spawnInFlight = undefined;
    this.clearRecoveryGraceTimer(runtime);

    if (!runtime.desired) return { kind: 'stopped' };

    if (exitedMode === 'resume') {
      runtime.consecutiveResumeExits += 1;
      if (runtime.consecutiveResumeExits >= MAX_AGENT_RESUME_ATTEMPTS) {
        runtime.consecutiveResumeExits = MAX_AGENT_RESUME_ATTEMPTS;
        return { kind: 'respawnFresh' };
      }
      return { kind: 'respawnResume' };
    }

    if (freshRecovery && runtime.consecutiveResumeExits >= MAX_AGENT_RESUME_ATTEMPTS) {
      runtime.desired = false;
      runtime.consecutiveResumeExits = 0;
      return { kind: 'failed' };
    }

    runtime.consecutiveResumeExits = 0;
    return { kind: 'respawnResume' };
  }

  forget(): void {
    const runtime = this.runtime;
    if (runtime) this.clearRecoveryGraceTimer(runtime);
    this.runtime = null;
  }

  private scheduleRecoveryReset(runtime: AgentRuntimeState, pty: Pty): void {
    this.clearRecoveryGraceTimer(runtime);
    runtime.recoveryGraceTimer = setTimeout(() => {
      if (this.runtime !== runtime) return;
      if (runtime.active?.pty !== pty || !runtime.active.freshRecovery) return;

      runtime.active = {
        ...runtime.active,
        freshRecovery: false,
      };
      runtime.consecutiveResumeExits = 0;
      runtime.recoveryGraceTimer = undefined;
    }, AGENT_FRESH_RECOVERY_GRACE_MS);
  }

  private clearRecoveryGraceTimer(runtime: AgentRuntimeState): void {
    if (!runtime.recoveryGraceTimer) return;
    clearTimeout(runtime.recoveryGraceTimer);
    runtime.recoveryGraceTimer = undefined;
  }

  private getOrCreateRuntime(): AgentRuntimeState {
    if (!this.runtime) {
      this.runtime = {
        desired: false,
        consecutiveResumeExits: 0,
      };
    }
    return this.runtime;
  }
}
