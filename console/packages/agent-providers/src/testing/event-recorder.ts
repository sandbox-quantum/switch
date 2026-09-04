import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';

type EventOf<T extends ProviderRuntimeEventType> = Extract<ProviderRuntimeEvent, { type: T }>;

/**
 * Collects an adapter's events and lets a test wait for the next one matching
 * a predicate. Every wait has a deadline so a stalled provider fails the test
 * with the events seen so far instead of hanging.
 */
export class EventRecorder {
  readonly events: ProviderRuntimeEvent[] = [];
  private readonly waiters = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly unsubscribe: () => void;

  constructor(adapter: ProviderAdapter) {
    this.unsubscribe = adapter.subscribe((event) => {
      this.events.push(event);
      for (const waiter of [...this.waiters]) waiter(event);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.waiters.clear();
  }

  ofType<T extends ProviderRuntimeEventType>(type: T): EventOf<T>[] {
    return this.events.filter((event): event is EventOf<T> => event.type === type);
  }

  /** Resolves with the first event (already seen or future) matching `type` and `predicate`. */
  waitFor<T extends ProviderRuntimeEventType>(
    type: T,
    predicate: (event: EventOf<T>) => boolean = () => true,
    timeoutMs = 60_000
  ): Promise<EventOf<T>> {
    const existing = this.ofType(type).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(`Timed out after ${timeoutMs}ms waiting for ${type}. Seen: ${this.summary()}`)
        );
      }, timeoutMs);
      const waiter = (event: ProviderRuntimeEvent) => {
        if (event.type !== type) return;
        const typed = event as EventOf<T>;
        if (!predicate(typed)) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(typed);
      };
      this.waiters.add(waiter);
    });
  }

  /** Assistant text accumulated for a turn, from deltas and completed message items. */
  assistantText(turnId: string): string {
    const deltas = this.ofType('content.delta')
      .filter((event) => event.turnId === turnId)
      .map((event) => event.delta)
      .join('');
    if (deltas.length > 0) return deltas;
    return this.ofType('item.completed')
      .filter((event) => event.turnId === turnId && event.item.type === 'assistant_message')
      .map((event) => event.item.text ?? '')
      .join('\n');
  }

  summary(): string {
    return this.events.map((event) => event.type).join(' > ') || '(none)';
  }
}
