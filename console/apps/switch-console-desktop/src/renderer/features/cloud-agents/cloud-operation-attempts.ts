import { observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { CloudOperationOutcome } from '@shared/core/cloud-agents/cloud-agents';

export type CloudOperationAttempt = {
  operationId: string;
  sessionId: string;
  status: 'pending' | 'unknown';
  message: string | null;
};

/**
 * Starts and restarts of cloud sessions that have not reached a definite
 * result, keyed by what they act on and kept outside any component so a
 * remount does not forget them. Asking again reuses the attempt's operation
 * id, which the server dedupes, so a lost response never queues a second
 * session or restart.
 */
class CloudOperationAttempts {
  private readonly attempts = observable.map<string, CloudOperationAttempt>();

  get(key: string): CloudOperationAttempt | undefined {
    return this.attempts.get(key);
  }

  /** Forget an attempt whose outcome was settled some other way. */
  settle(key: string): void {
    runInAction(() => this.attempts.delete(key));
  }

  /** Resolves to null when the attempt is already in flight. */
  async run(
    key: string,
    agentKey: string,
    action: 'start' | 'restart',
    sessionId: string | null
  ): Promise<{ sessionId: string; outcome: CloudOperationOutcome } | null> {
    const existing = this.attempts.get(key);
    if (existing?.status === 'pending') return null;
    const target = existing?.sessionId ?? sessionId ?? crypto.randomUUID();
    const attempt: CloudOperationAttempt = {
      operationId: existing?.operationId ?? (action === 'start' ? target : crypto.randomUUID()),
      sessionId: target,
      status: 'pending',
      message: null,
    };
    runInAction(() => this.attempts.set(key, attempt));
    let outcome: CloudOperationOutcome;
    try {
      outcome = await rpc.sdkHost.cloudSessionOperation(
        agentKey,
        attempt.sessionId,
        attempt.operationId,
        action
      );
    } catch (error) {
      outcome = { state: 'unknown', message: String(error) };
    }
    runInAction(() => {
      if (outcome.state === 'unknown')
        this.attempts.set(key, { ...attempt, status: 'unknown', message: outcome.message });
      else this.attempts.delete(key);
    });
    return { sessionId: attempt.sessionId, outcome };
  }
}

export const cloudOperationAttempts = new CloudOperationAttempts();

export function startAttemptKey(agentKey: string): string {
  return `start:${agentKey}`;
}

export function restartAttemptKey(agentKey: string, sessionId: string): string {
  return `restart:${agentKey}:${sessionId}`;
}
