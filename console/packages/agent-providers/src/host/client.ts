import type {
  ClientCommand,
  CommandStatus,
  SessionTransport,
} from '@switch-console/shared/session-v1';
import { commandStatusSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { HostEndpoint, HostStartRequest } from './server';

const endpointSchema = z.strictObject({
  url: z.string().url(),
  token: z.string().min(1),
  pid: z.number().int().positive(),
});

/** Private, authenticated host protocol. It is not the Switch gateway API. */
export class HostConnection implements SessionTransport {
  readonly endpoint: HostEndpoint;
  constructor(endpoint: unknown) {
    this.endpoint = endpointSchema.parse(endpoint);
    const url = new URL(this.endpoint.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw new Error('Use an authenticated loopback endpoint or an SSH forward.');
  }
  async request(path: string, data?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint.url}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.endpoint.token}`,
        'content-type': 'application/json',
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`SDK host ${response.status}: ${await response.text()}`);
    return response.json();
  }
  start(input: HostStartRequest): Promise<unknown> {
    return this.request('/sessions', input);
  }
  list(): Promise<unknown> {
    return this.request('/sessions');
  }
  snapshot(sessionId: string, pageToken: string | null): Promise<unknown> {
    if (pageToken !== null) throw new Error('Local host snapshots are not paginated.');
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  }
  async submit(command: ClientCommand): Promise<CommandStatus> {
    return commandStatusSchema.parse(
      await this.request(`/sessions/${encodeURIComponent(command.sessionId)}/commands`, command)
    );
  }
  async commandStatus(sessionId: string, commandId: string): Promise<CommandStatus> {
    return commandStatusSchema.parse(
      await this.request(
        `/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`
      )
    );
  }
  subscribe(
    sessionId: string,
    after: number,
    onEvent: (event: unknown) => void,
    onError: (error: Error) => void,
    onCursor: (sequence: number) => void
  ): () => void {
    let stopped = false;
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const batch = z
          .strictObject({
            events: z.array(z.unknown()),
            throughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .parse(
            await this.request(`/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`)
          );
        if (stopped) return;
        for (const event of batch.events) onEvent(event);
        onCursor(batch.throughSequence);
        cursor = batch.throughSequence;
        timer = setTimeout(() => void poll(), 250);
      } catch (error) {
        if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
