import { z } from 'zod';

/**
 * A room message the agent's controller routed to one of its sessions, with
 * the event itself as the agent's stream delivered it: the session builds its
 * prompt from this, since Switch keeps no copy. Numbered in the agent's
 * inbound event sequence.
 */
export const handoffSchema = z.strictObject({
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  event: z.unknown().optional(),
});
export type Handoff = z.infer<typeof handoffSchema>;

/**
 * Wakes the host's loop when its parent hands it something over IPC, so what
 * a room message or an approval answer waits for is not the loop's interval.
 */
export class HostWaker {
  private handedOver = false;
  private approvals = false;
  private wake: (() => void) | null = null;

  /** Something was handed over for the loop to take up. */
  nudge(): void {
    this.handedOver = true;
    this.wake?.();
  }

  /** Switch has an answer to one of this session's approval requests. */
  approvalsWaiting(): void {
    this.approvals = true;
    this.wake?.();
  }

  takeApprovalWake(): boolean {
    const pending = this.approvals;
    this.approvals = false;
    return pending;
  }

  /** Waits out `ms`, or returns as soon as the parent hands something over. */
  idle(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (this.handedOver || this.approvals) {
        this.handedOver = false;
        return resolve();
      }
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wake = null;
        this.handedOver = false;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
