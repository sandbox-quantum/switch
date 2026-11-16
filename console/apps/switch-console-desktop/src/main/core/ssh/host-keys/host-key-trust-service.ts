import type { HostKeyProblem } from '@shared/core/ssh/host-keys';

export type HostKeyDecision = 'trusted' | 'dismissed';

type Pending = {
  problem: HostKeyProblem;
  key: Buffer;
  waiters: Array<(decision: HostKeyDecision) => void>;
};

type HostKeyTrustLog = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
};

export type HostKeyTrustServiceDeps = {
  /** Record a key as trusted for a name (Console's own known_hosts). */
  trust: (hostKeyName: string, key: Buffer) => Promise<void>;
  publish: (problems: HostKeyProblem[]) => void;
  log: HostKeyTrustLog;
};

const decisionKey = (sshHost: string, fingerprint: string) => `${sshHost}\n${fingerprint}`;

/**
 * Host keys the verifier refused, waiting for the user.
 *
 * A refusal fails the connection at once rather than holding it open on a
 * prompt (ssh2's handshake timeout and the server's login grace period would
 * both run out under a user reading a fingerprint). The key is kept here and
 * the renderer asks; only an explicit `trust` records it, and the caller then
 * reconnects. Nothing here ever trusts a key on its own, so background
 * connections and reconnects only ever use a decision the user made.
 */
export class HostKeyTrustService {
  private readonly pending = new Map<string, Pending>();
  /** Keys the user turned down this run, so background retries do not ask again. */
  private readonly dismissed = new Set<string>();

  constructor(private readonly deps: HostKeyTrustServiceDeps) {}

  list(): HostKeyProblem[] {
    return [...this.pending.values()].map((entry) => entry.problem);
  }

  /** Called by the verifier for every refused key. */
  report(problem: HostKeyProblem, key: Buffer): void {
    const existing = this.pending.get(problem.sshHost);
    if (existing?.problem.fingerprint === problem.fingerprint) return;
    if (this.dismissed.has(decisionKey(problem.sshHost, problem.fingerprint))) return;

    this.deps.log.warn('HostKeyTrustService: refused SSH host key', {
      event: 'ssh_host_key_refused',
      sshHost: problem.sshHost,
      kind: problem.kind,
      fingerprint: problem.fingerprint,
    });
    existing?.waiters.forEach((resolve) => resolve('dismissed'));
    this.pending.set(problem.sshHost, { problem, key, waiters: [] });
    this.publish();
  }

  /**
   * Called by the verifier when a host's key checked out, which settles a key
   * still waiting for that host — the user may have added it to known_hosts
   * themselves, or it may have been a different alias for the same host.
   */
  reportVerified(sshHost: string): void {
    const entry = this.pending.get(sshHost);
    if (entry) this.settle(sshHost, entry, 'trusted');
  }

  /**
   * Resolves when the user decides about the host's pending key, or undefined
   * when there is nothing for them to decide (no pending key, or one that
   * cannot be trusted from here).
   */
  waitForDecision(sshHost: string): Promise<HostKeyDecision> | undefined {
    const entry = this.pending.get(sshHost);
    if (!entry || entry.problem.trustRefusal) return undefined;
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  /**
   * Trust the key the host presented. `fingerprint` names the key the user
   * was shown; if the host has since presented another, nothing is trusted.
   */
  async trust(sshHost: string, fingerprint: string): Promise<void> {
    const entry = this.pending.get(sshHost);
    if (!entry || entry.problem.fingerprint !== fingerprint) {
      throw new Error(
        `No SSH host key ${fingerprint} is waiting for '${sshHost}'. Retry the connection to see the key it presents now.`
      );
    }
    if (entry.problem.trustRefusal) throw new Error(entry.problem.trustRefusal);

    await this.deps.trust(entry.problem.hostKeyName, entry.key);
    this.deps.log.info('HostKeyTrustService: SSH host key trusted', {
      event: 'ssh_host_key_trusted',
      sshHost,
      kind: entry.problem.kind,
      fingerprint,
    });
    this.settle(sshHost, entry, 'trusted');
  }

  /** The user turned the key down; stop asking about it until they retry. */
  dismiss(sshHost: string, fingerprint: string): void {
    this.dismissed.add(decisionKey(sshHost, fingerprint));
    const entry = this.pending.get(sshHost);
    if (entry?.problem.fingerprint === fingerprint) this.settle(sshHost, entry, 'dismissed');
  }

  /** An explicit retry asks again about a key the user turned down earlier. */
  clearDismissals(sshHost: string): void {
    for (const key of this.dismissed) {
      if (key.startsWith(`${sshHost}\n`)) this.dismissed.delete(key);
    }
  }

  private settle(sshHost: string, entry: Pending, decision: HostKeyDecision): void {
    this.pending.delete(sshHost);
    entry.waiters.forEach((resolve) => resolve(decision));
    this.publish();
  }

  private publish(): void {
    this.deps.publish(this.list());
  }
}
