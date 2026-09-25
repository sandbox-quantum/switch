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
  private wakeLoop: (() => void) | null = null;
  private wakeReporting: (() => void) | null = null;

  /** Something was handed over for the session loop to take up. */
  nudge(): void {
    this.handedOver = true;
    this.wakeLoop?.();
  }

  /** Switch has an answer to one of this session's approval requests. */
  approvalsWaiting(): void {
    this.approvals = true;
    this.wakeReporting?.();
  }

  takeApprovalWake(): boolean {
    const pending = this.approvals;
    this.approvals = false;
    return pending;
  }

  /** The session loop: waits out `ms`, or returns as soon as the parent hands something over. */
  idle(ms: number, signal: AbortSignal): Promise<void> {
    return this.wait(ms, signal, 'loop');
  }

  /** The reporting loop: waits out `ms`, or returns as soon as Switch has an answer waiting. */
  idleReporting(ms: number, signal: AbortSignal): Promise<void> {
    return this.wait(ms, signal, 'reporting');
  }

  private wait(ms: number, signal: AbortSignal, who: 'loop' | 'reporting'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (who === 'loop' && this.handedOver) {
        this.handedOver = false;
        return resolve();
      }
      if (who === 'reporting' && this.approvals) return resolve();
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (who === 'loop') {
          this.wakeLoop = null;
          this.handedOver = false;
        } else this.wakeReporting = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(finish, ms);
      if (who === 'loop') this.wakeLoop = finish;
      else this.wakeReporting = finish;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
