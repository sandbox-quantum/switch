import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

const REDACTED = Buffer.from('[REDACTED]');

function secretBuffers(values: readonly string[]): Buffer[] {
  return [...new Set(values.filter(Boolean))]
    .map((value) => Buffer.from(value))
    .sort((left, right) => right.length - left.length);
}

function matchAt(input: Buffer, offset: number, secrets: readonly Buffer[]): Buffer | undefined {
  return secrets.find(
    (secret) =>
      offset + secret.length <= input.length &&
      input.subarray(offset, offset + secret.length).equals(secret)
  );
}

function redactPrefix(
  input: Buffer,
  scanLimit: number,
  secrets: readonly Buffer[]
): { output: Buffer; consumed: number } {
  const parts: Buffer[] = [];
  let literalStart = 0;
  let cursor = 0;
  while (cursor < scanLimit) {
    const secret = matchAt(input, cursor, secrets);
    if (!secret) {
      cursor += 1;
      continue;
    }
    if (literalStart < cursor) parts.push(input.subarray(literalStart, cursor));
    parts.push(REDACTED);
    cursor += secret.length;
    literalStart = cursor;
  }
  if (!parts.length) return { output: input.subarray(0, cursor), consumed: cursor };
  if (literalStart < cursor) parts.push(input.subarray(literalStart, cursor));
  return { output: Buffer.concat(parts), consumed: cursor };
}

/** Exact-value redaction that prefers the longest value when secrets overlap. */
export function redactHostedText(text: string, values: string[]): string {
  const secrets = secretBuffers(values);
  if (!secrets.length) return text;
  return redactPrefix(Buffer.from(text), Buffer.byteLength(text), secrets).output.toString();
}

/**
 * Streaming exact-value redaction. It retains at most maxSecretLength - 1 raw bytes,
 * which is enough to decide whether a secret continues in the next chunk.
 */
export class HostedLogRedactor {
  private pending = Buffer.alloc(0);
  private readonly secrets: Buffer[];
  private readonly retainedBytes: number;

  constructor(secrets: Buffer[]) {
    if (!secrets.length) throw new Error('Hosted log redaction requires at least one secret.');
    this.secrets = [...secrets].sort((left, right) => right.length - left.length);
    this.retainedBytes = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  push(chunk: Buffer): Buffer {
    const combined = Buffer.concat([this.pending, chunk]);
    const scanLimit = Math.max(0, combined.length - this.retainedBytes);
    const { output, consumed } = redactPrefix(combined, scanLimit, this.secrets);
    this.pending = Buffer.from(combined.subarray(consumed));
    return output;
  }

  finish(): Buffer {
    const output = redactPrefix(this.pending, this.pending.length, this.secrets).output;
    this.pending = Buffer.alloc(0);
    return output;
  }
}

async function consume(stream: Readable, file: FileHandle, secrets: Buffer[]): Promise<void> {
  const redactor = new HostedLogRedactor(secrets);
  for await (const chunk of stream) {
    const output = redactor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (output.length) await file.write(output);
  }
  const output = redactor.finish();
  if (output.length) await file.write(output);
}

export async function pipeRedactedHostedLogs(
  streams: Readable[],
  file: FileHandle,
  values: string[]
): Promise<void> {
  const secrets = secretBuffers(values);
  if (!secrets.length) throw new Error('Hosted log redaction requires at least one secret.');
  await Promise.all(streams.map((stream) => consume(stream, file, secrets)));
}
