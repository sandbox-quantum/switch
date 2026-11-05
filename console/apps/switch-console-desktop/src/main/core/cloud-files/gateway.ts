import {
  GatewayError,
  gatewayFetch,
  gatewayRequest,
} from '@main/core/switch-servers/gateway-client';
import {
  CLOUD_FILE_MAX_BYTES,
  CLOUD_FILES_CODES,
  type CloudFileEntry,
  type CloudFileListing,
  type CloudFilesCode,
  CloudFilesError,
} from '@shared/core/cloud-files/cloud-files';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Console's side of Core's owner-only `/gateway/cloud-files` routes
 * (engineer-4's v3.1, section 3). Core picks the box from the signed-in user;
 * Console sends only a box-relative path. Every failure becomes a
 * `CloudFilesError` carrying a fixed code, never a path or the server's text.
 */

const BASE = '/cloud-files';

/** Waits before each retry of `503 files_elsewhere`: three tries after the first. */
export const FILES_ELSEWHERE_BACKOFF_MS = [300, 800, 2000] as const;

/** The code in a refusal's body, `{"detail": {"code": …}}`, if it's one of ours. */
function codeFromBody(body: string | undefined): CloudFilesCode | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: { code?: unknown } };
    const code = parsed.detail?.code;
    return typeof code === 'string' && (CLOUD_FILES_CODES as readonly string[]).includes(code)
      ? (code as CloudFilesCode)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A failure from the gateway, as a code-only `CloudFilesError`. */
export function toCloudFilesError(error: unknown): unknown {
  if (error instanceof CloudFilesError) return error;
  if (error instanceof GatewayError) {
    if (error.kind === 'network') return new CloudFilesError('unreachable');
    if (error.kind === 'http') {
      const code = codeFromBody(error.body);
      if (code) return new CloudFilesError(code, error.status);
      if (error.status === 503) return new CloudFilesError('files_elsewhere', 503);
      return new CloudFilesError('unknown', error.status);
    }
  }
  return error;
}

/**
 * Runs `call`, retrying `503 files_elsewhere` (another Core pod holds the
 * box's connection, or Core restarted mid-request) three times with backoff.
 * After that, the person reads "Couldn't reach your cloud. Try again."
 */
export async function withFilesElsewhereRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (caught) {
      const error = toCloudFilesError(caught);
      const elsewhere = error instanceof CloudFilesError && error.code === 'files_elsewhere';
      if (!elsewhere) throw error;
      const wait = FILES_ELSEWHERE_BACKOFF_MS[attempt];
      if (wait === undefined) throw new CloudFilesError('unreachable', 503);
      await sleep(wait);
    }
  }
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) search.set(key, value);
  return search.toString();
}

function isEntry(value: unknown): value is CloudFileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    (entry.kind === 'file' || entry.kind === 'folder') &&
    typeof entry.size === 'number' &&
    typeof entry.mtime === 'number' &&
    (entry.collapsed === undefined || typeof entry.collapsed === 'boolean') &&
    (entry.label === undefined || typeof entry.label === 'string') &&
    (entry.agent === undefined || typeof entry.agent === 'string')
  );
}

/** One page of a folder listing. `path` is box-relative; '' is the top level. */
export async function listCloudFiles(
  server: SwitchServer,
  path: string,
  cursor?: string
): Promise<CloudFileListing> {
  return withFilesElsewhereRetry(async () => {
    const response = await gatewayFetch(server, `${BASE}/list?${query({ path, cursor })}`, {
      authenticated: true,
    });
    const body = (await response.json()) as { entries?: unknown; cursor?: unknown };
    if (!Array.isArray(body.entries)) throw new CloudFilesError('bad_reply');
    return {
      entries: body.entries.filter(isEntry),
      ...(typeof body.cursor === 'string' && body.cursor ? { cursor: body.cursor } : {}),
    };
  });
}

/** One chunk of a file: its bytes, where they sit, and the file's total size. */
export type CloudFileRange =
  | { done: false; bytes: Uint8Array; start: number; total: number }
  | { done: true; total: number };

/** `bytes a-b/total`, or the past-the-end form with `*` for the range, as Core sends it. */
function parseContentRange(header: string | null): { start: number; total: number } | null {
  if (!header) return null;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (range) return { start: Number(range[1]), total: Number(range[3]) };
  const end = /^bytes \*\/(\d+)$/.exec(header.trim());
  if (end) return { start: -1, total: Number(end[1]) };
  return null;
}

/**
 * One 128 KiB range of a file from `offset`. Core answers `206` with
 * `Content-Range: bytes a-b/total`, or `416` (the range given as `*`) at or
 * past the end. Raw: a workspace file can be any type, HTML included.
 */
export async function readCloudFileRange(
  server: SwitchServer,
  path: string,
  offset: number
): Promise<CloudFileRange> {
  return withFilesElsewhereRetry(async () => {
    // gatewayRequest, not gatewayFetch: a 416 must keep its Content-Range header.
    const response = await gatewayRequest(
      server,
      `${BASE}/content?${query({ path, offset: String(offset) })}`,
      { authenticated: true, raw: true, signal: AbortSignal.timeout(CHUNK_DEADLINE_MS) }
    );
    const range = parseContentRange(response.headers.get('content-range'));
    if (response.status === 416) {
      await response.body?.cancel();
      if (!range || range.start !== -1) throw new CloudFilesError('bad_reply', 416);
      return { done: true, total: range.total };
    }
    if (!response.ok) throw await refusal(response);
    if (response.status !== 206 || !range || range.start !== offset) {
      await response.body?.cancel();
      throw new CloudFilesError('bad_reply', response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { done: false, bytes, start: range.start, total: range.total };
  });
}

/** A refused response as a code-only error, from its `{"detail": {"code"}}` body. */
async function refusal(response: Response): Promise<CloudFilesError> {
  const body = await response.text().catch(() => '');
  const code = codeFromBody(body);
  if (code) return new CloudFilesError(code, response.status);
  if (response.status === 503) return new CloudFilesError('files_elsewhere', 503);
  return new CloudFilesError('unknown', response.status);
}

/** How long one chunk may take: Core's own chunk deadline is shorter. */
const CHUNK_DEADLINE_MS = 45_000;

/**
 * Every chunk of a file, in order, from the start. Stops at the file's total
 * size, and refuses a file over `max` (25 MB by default) before reading on.
 */
export async function* readCloudFileChunks(
  server: SwitchServer,
  path: string,
  max: number = CLOUD_FILE_MAX_BYTES
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (;;) {
    const range = await readCloudFileRange(server, path, offset);
    if (range.done) return;
    if (range.total > max) throw new CloudFilesError('too_large', 413);
    if (range.bytes.byteLength === 0) {
      if (offset >= range.total) return;
      throw new CloudFilesError('bad_reply');
    }
    yield range.bytes;
    offset += range.bytes.byteLength;
    if (offset > range.total) throw new CloudFilesError('bad_reply');
    if (offset === range.total) return;
  }
}

/** A whole file into memory, for a preview: at most `max` bytes. */
export async function readCloudFile(
  server: SwitchServer,
  path: string,
  max: number
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of readCloudFileChunks(server, path, max)) {
    size += chunk.byteLength;
    if (size > max) throw new CloudFilesError('too_large', 413);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** How long a folder zip may take in all: Core caps it at 500 MB. */
const ZIP_DEADLINE_MS = 30 * 60 * 1000;

/**
 * A folder as a zip, streamed: the response body as it comes. `caches` asks
 * for `node_modules` and the like too. The caller reads the body to disk.
 */
export async function openCloudZip(
  server: SwitchServer,
  path: string,
  caches: boolean,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  return withFilesElsewhereRetry(async () => {
    const timeout = AbortSignal.timeout(ZIP_DEADLINE_MS);
    const response = await gatewayRequest(
      server,
      `${BASE}/zip?${query({ path, caches: caches ? '1' : '0' })}`,
      {
        authenticated: true,
        raw: true,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }
    );
    if (!response.ok) throw await refusal(response);
    if (!response.body) throw new CloudFilesError('bad_reply');
    return response.body;
  });
}
