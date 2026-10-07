import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Exact-value redaction of secrets: what a host scrubs from the logs, journals
 * and messages it writes. A cloud deployment's credentials are known when it
 * starts; the service tokens a session is given are added as they are issued,
 * so whatever redacts reads the values it holds at that moment.
 */

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
export function redactText(text: string, values: readonly string[]): string {
  const secrets = secretBuffers(values);
  if (!secrets.length) return text;
  return redactPrefix(Buffer.from(text), Buffer.byteLength(text), secrets).output.toString();
}

/**
 * The forms an issued token can be written in: as it is, URL-encoded, and as
 * the base64 of `x-access-token:<token>`, which is how Git sends GitHub's
 * in an `Authorization` header (and so how a Git trace shows it).
 */
export function tokenForms(token: string): string[] {
  return [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`).toString('base64'),
  ];
}

/** The service tokens a process has handed out, in every form, to scrub wherever it writes. */
export class Redactions {
  private readonly values = new Set<string>();

  add(token: string): void {
    for (const form of tokenForms(token)) this.values.add(form);
  }

  list(): string[] {
    return [...this.values];
  }

  text(input: string): string {
    return this.values.size ? redactText(input, this.list()) : input;
  }

  /**
   * How many characters at the end of `text` could be the start of a value
   * held here: text still streaming in holds them back, so a token arriving
   * over several chunks is never shown in part.
   */
  unfinished(text: string): number {
    let longest = 0;
    for (const value of this.values)
      for (let length = Math.min(value.length - 1, text.length); length > longest; length--)
        if (text.endsWith(value.slice(0, length))) {
          longest = length;
          break;
        }
    return longest;
  }

  /** `input` with every string in it redacted: for JSON values, such as a tool call's arguments. */
  value<T>(input: T): T {
    if (!this.values.size) return input;
    const values = this.list();
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return redactText(value, values);
      if (Array.isArray(value)) return value.map(walk);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
      return value;
    };
    return walk(input) as T;
  }
}

/**
 * Streaming exact-value redaction. It retains at most one byte less than the
 * longest secret, which is enough to decide whether a secret continues in the
 * next chunk. `secrets` is read on every chunk, so a value added later is
 * scrubbed from everything written after it was added.
 */
export class LogRedactor {
  private pending = Buffer.alloc(0);
  private seen: readonly string[] = [];
  private secrets: Buffer[] = [];

  constructor(private readonly source: () => readonly string[]) {}

  private current(): Buffer[] {
    const values = this.source();
    if (values.length !== this.seen.length) {
      this.seen = values;
      this.secrets = secretBuffers(values);
    }
    return this.secrets;
  }

  push(chunk: Buffer): Buffer {
    const secrets = this.current();
    const combined = Buffer.concat([this.pending, chunk]);
    const retained = Math.max(0, ...secrets.map((secret) => secret.length - 1));
    const scanLimit = Math.max(0, combined.length - retained);
    const { output, consumed } = redactPrefix(combined, scanLimit, secrets);
    this.pending = Buffer.from(combined.subarray(consumed));
    return output;
  }

  finish(): Buffer {
    const output = redactPrefix(this.pending, this.pending.length, this.current()).output;
    this.pending = Buffer.alloc(0);
    return output;
  }
}

async function consume(
  stream: Readable,
  file: FileHandle,
  secrets: () => readonly string[]
): Promise<void> {
  const redactor = new LogRedactor(secrets);
  for await (const chunk of stream) {
    const output = redactor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (output.length) await file.write(output);
  }
  const output = redactor.finish();
  if (output.length) await file.write(output);
}

/** Copy each stream into `file`, scrubbing the values `secrets` holds as each chunk is written. */
export async function pipeRedactedLogs(
  streams: Readable[],
  file: FileHandle,
  secrets: () => readonly string[]
): Promise<void> {
  await Promise.all(streams.map((stream) => consume(stream, file, secrets)));
}
