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

/**
 * GitHub's token shapes, matched whether or not this process issued the token:
 * one a sibling session fetched, or fetched before this session resumed or its
 * host restarted, or cut short in a title, all of which an exact value misses.
 * Four characters after the prefix tell a cut token from prose. No word
 * boundary before it: escaped or encoded text glues a token to what precedes
 * it (`\nghs_…` in JSON, `%3Aghs_…` in a URL).
 */
const TOKEN_SHAPES = [
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{4,}/g,
  // `x-access-token:<token>` in base64, as Git sends it and a Git trace shows it.
  /eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/]*={0,2}/g,
];

const CUT_TAIL_MIN = 8;

function redactShapes(text: string): string {
  return TOKEN_SHAPES.reduce((output, shape) => output.replace(shape, '[REDACTED]'), text);
}

/**
 * The service tokens a process has handed out, in every form, to scrub wherever
 * it writes, and anything shaped like a GitHub token besides.
 */
export class Redactions {
  private readonly values = new Set<string>();

  add(token: string): void {
    for (const form of tokenForms(token)) this.values.add(form);
  }

  /** Values another holder listed, already in every form: a session takes its host's. */
  addListed(values: readonly string[]): void {
    for (const value of values) if (value) this.values.add(value);
  }

  list(): string[] {
    return [...this.values];
  }

  text(input: string): string {
    if (!this.values.size) return redactShapes(input);
    return redactShapes(this.cutTail(redactText(input, this.list())));
  }

  /**
   * `input` with its end redacted when that end is the start of a value held
   * here, before a closing ellipsis or not: what a title cut short through a
   * token leaves, which no exact match finds. Eight characters or more, so
   * ordinary text that happens to end the way a token begins is left alone.
   */
  private cutTail(input: string): string {
    const ellipsis = input.endsWith('…') ? '…' : '';
    const body = ellipsis ? input.slice(0, -1) : input;
    const held = this.unfinished(body);
    return held >= CUT_TAIL_MIN
      ? `${body.slice(0, body.length - held)}[REDACTED]${ellipsis}`
      : input;
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
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return this.text(value);
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

/** How much of a line without its end is held for shape redaction before it is written anyway. */
const SHAPE_LINE_LIMIT = 64 * 1024;

/**
 * Streaming redaction of GitHub's token shapes, a line at a time: a token
 * issued before this host started, which no exact value names, split over
 * chunks is still whole within its line. Bytes are read as latin1, one
 * character each, so a line held past `SHAPE_LINE_LIMIT` is never cut inside
 * a UTF-8 character's bytes when it is put back.
 */
export class ShapeLineRedactor {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    const combined = Buffer.concat([this.pending, chunk]);
    const end = combined.lastIndexOf(0x0a) + 1;
    const cut = end > 0 ? end : combined.length > SHAPE_LINE_LIMIT ? longLineCut(combined) : 0;
    this.pending = Buffer.from(combined.subarray(cut));
    return redactShapeBytes(combined.subarray(0, cut));
  }

  finish(): Buffer {
    const output = redactShapeBytes(this.pending);
    this.pending = Buffer.alloc(0);
    return output;
  }
}

/** Longer than any token's form a shape matches, base64 of a fine-grained one included. */
const SHAPE_TAIL = 256;

/**
 * Where to cut a line written before its end: short of its last
 * `SHAPE_TAIL` bytes, and short of any token-shaped text reaching into them,
 * which may go on in the next chunk and is held back whole.
 */
function longLineCut(line: Buffer): number {
  const text = line.toString('latin1');
  let cut = text.length - SHAPE_TAIL;
  for (const shape of TOKEN_SHAPES)
    for (const match of text.matchAll(shape))
      if (match.index + match[0].length > cut) cut = Math.min(cut, match.index);
  return Math.max(cut, 0);
}

function redactShapeBytes(input: Buffer): Buffer {
  return input.length ? Buffer.from(redactShapes(input.toString('latin1')), 'latin1') : input;
}

async function consume(
  stream: Readable,
  file: FileHandle,
  secrets: () => readonly string[]
): Promise<void> {
  const redactor = new LogRedactor(secrets);
  const shapes = new ShapeLineRedactor();
  for await (const chunk of stream) {
    const output = shapes.push(redactor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    if (output.length) await file.write(output);
  }
  const output = Buffer.concat([shapes.push(redactor.finish()), shapes.finish()]);
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
