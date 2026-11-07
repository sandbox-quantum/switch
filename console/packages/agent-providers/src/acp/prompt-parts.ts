type PromptBlock = Record<string, unknown>;

const COLLECT =
  'Message continues in another part. Reply only "OK"; wait to act until the final part.\n\n';
const FINISH =
  'Final part of the message. Read all its parts together and act on the complete message.\n\n';

/** Size includes JSON escaping, UTF-8, request metadata and the terminating newline. */
function lineBytes(sessionId: string, prompt: PromptBlock[]): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        method: 'session/prompt',
        params: { sessionId, prompt },
      })
    ) + 1
  );
}

/** Keep attachments on the final message and refuse oversize attachments before sending any part. */
export function promptParts(
  sessionId: string,
  text: string,
  attachments: PromptBlock[],
  limit: number | undefined
): PromptBlock[][] {
  const whole = [{ type: 'text', text }, ...attachments];
  if (limit === undefined || lineBytes(sessionId, whole) <= limit) return [whole];
  const budget = Math.min(
    limit - lineBytes(sessionId, [{ type: 'text', text: COLLECT }]),
    limit - lineBytes(sessionId, [{ type: 'text', text: FINISH }, ...attachments])
  );
  if (budget < 12)
    throw new Error('Attachment exceeds the provider input limit; send a smaller attachment.');
  const chunks: string[] = [];
  let chunk = '';
  let used = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (used + cost > budget) {
      chunks.push(chunk);
      chunk = '';
      used = 0;
    }
    chunk += character;
    used += cost;
  }
  chunks.push(chunk);
  return chunks.map((part, index) =>
    index === chunks.length - 1
      ? [{ type: 'text', text: FINISH + part }, ...attachments]
      : [{ type: 'text', text: COLLECT + part }]
  );
}
