/**
 * The agent bridge's SSE framing.
 *
 * One implementation, imported by everything that speaks the protocol: the
 * local MCP runtime next to the agent, and Switch Console. It used to exist twice —
 * separate deployables, no shared package — and the copies drifted within a day
 * of being made. This package is what removed the excuse.
 *
 * Deliberately free of imports and of anything specific to a host: it is the
 * wire format and nothing else. Reporting, reconnection, heartbeats and cursors
 * belong to the caller, which is where clients legitimately differ.
 */

export type SseFrame = { event: string; id?: string; data: Record<string, unknown> };

/** Parse an SSE byte stream into frames, ending when the stream or signal does. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffered.indexOf('\n\n')) !== -1) {
        const raw = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);

        let event = 'message';
        let id: string | undefined;
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          // A comment line is the server's keepalive: it stops proxies timing
          // the stream out for idleness and carries nothing.
          if (line.startsWith(':')) continue;
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }
        if (!dataLines.length) continue;
        // A frame we cannot parse is a frame we have lost. Surface it rather
        // than skipping quietly; the caller decides how loud to be.
        yield { event, id, data: JSON.parse(dataLines.join('\n')) };
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
