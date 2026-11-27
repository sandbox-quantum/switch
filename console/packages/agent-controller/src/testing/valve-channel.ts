import type { openHubStream } from '@switch-console/agent-providers';

/** The valve channel a box's hub stream takes (`HubStreamBox['valveChannel']`). */
export type HubStreamValveChannel = NonNullable<
  Parameters<typeof openHubStream>[1]
>['valveChannel'];

/**
 * A stand-in for the agent host's `HubValveChannel`, which the box subpath
 * doesn't export: the same five members, so the hub stream binds its socket
 * to it and the host's valve listens on it, as on a box.
 */
export function valveChannel(): HubStreamValveChannel {
  let sender: ((text: string) => boolean) | null = null;
  const messages = new Set<(message: unknown) => void>();
  const downs = new Set<() => void>();
  const channel = {
    bind(next: ((text: string) => boolean) | null): void {
      const wasUp = sender !== null;
      sender = next;
      if (wasUp && !next) for (const listener of downs) listener();
    },
    deliver(message: unknown): void {
      for (const listener of messages) listener(message);
    },
    send(message: unknown): boolean {
      return sender?.(JSON.stringify(message)) ?? false;
    },
    onMessage(listener: (message: unknown) => void): () => void {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onDown(listener: () => void): () => void {
      downs.add(listener);
      return () => downs.delete(listener);
    },
  };
  // The real class has private fields, so a copy is cast to its type.
  return channel as unknown as HubStreamValveChannel;
}
