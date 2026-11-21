import { createHash, randomBytes } from 'node:crypto';

/**
 * One-time host tickets: how the controller knows a hub connection comes from
 * the host it ordered, on boxes where the agents' processes run as another
 * user and their `/proc` can't be read (a split box).
 *
 * For every launch, and every reconnect of a living host, the controller mints
 * a fresh ticket and sends it to the launcher, which hands it to that host on
 * an inherited pipe. The host presents it at its hub `hello`. A ticket is 128
 * random bits, bound to one agent and one launch, good for one `hello`, and
 * gone about 10 s after it was minted. The launcher can't make one, and a host
 * started that the controller didn't order has none: it is refused, gets no
 * lease, and is logged as a WARN by the caller.
 */

export const TICKET_TTL_MS = 10_000;
/** How long a spent or expired ticket is remembered, so a replay is told apart from a guess. */
const REMEMBER_MS = 60_000;

export type TicketRefusal = 'unknown' | 'expired' | 'spent' | 'wrong_agent';

type Minted = { agentId: string; launchId: number; until: number };

export class HostTickets {
  /** Keyed by the ticket's hash, so the lookup never compares secrets character by character. */
  private readonly live = new Map<string, Minted>();
  private readonly gone = new Map<
    string,
    { agentId: string; why: 'spent' | 'expired'; until: number }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Buffer = randomBytes,
    private readonly ttlMs = TICKET_TTL_MS
  ) {}

  /** A new ticket for `agentId`'s launch `launchId`; any earlier unspent one for the agent stops working. */
  mint(agentId: string, launchId: number): string {
    this.prune();
    this.forget(agentId);
    const ticket = this.random(16).toString('hex');
    this.live.set(hash(ticket), { agentId, launchId, until: this.now() + this.ttlMs });
    return ticket;
  }

  /**
   * Takes `ticket` for a `hello` from `agentId`'s connection: the launch it was
   * minted for, once; otherwise why not. A ticket for another agent is refused
   * and spent, so it can't be tried again elsewhere.
   */
  take(
    agentId: string,
    ticket: string
  ): { ok: true; launchId: number } | { ok: false; reason: TicketRefusal } {
    this.prune();
    if (!/^[0-9a-f]{32}$/.test(ticket)) return { ok: false, reason: 'unknown' };
    const key = hash(ticket);
    const minted = this.live.get(key);
    if (!minted) {
      const gone = this.gone.get(key);
      return { ok: false, reason: gone ? gone.why : 'unknown' };
    }
    this.live.delete(key);
    this.gone.set(key, { agentId: minted.agentId, why: 'spent', until: this.now() + REMEMBER_MS });
    if (minted.agentId !== agentId) return { ok: false, reason: 'wrong_agent' };
    return { ok: true, launchId: minted.launchId };
  }

  /** Every unspent ticket for `agentId` stops working (it was stopped, or a new launch replaces them). */
  forget(agentId: string): void {
    for (const [key, minted] of this.live)
      if (minted.agentId === agentId) {
        this.live.delete(key);
        this.gone.set(key, { agentId, why: 'expired', until: this.now() + REMEMBER_MS });
      }
  }

  /** How many are waiting to be used; for tests and status. */
  get pending(): number {
    this.prune();
    return this.live.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, minted] of this.live)
      if (minted.until <= now) {
        this.live.delete(key);
        this.gone.set(key, { agentId: minted.agentId, why: 'expired', until: now + REMEMBER_MS });
      }
    for (const [key, gone] of this.gone) if (gone.until <= now) this.gone.delete(key);
  }
}

function hash(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}
