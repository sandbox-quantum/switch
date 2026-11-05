import {
  CLOUD_FILE_MAX_BYTES,
  CLOUD_FILES_CODES,
  type CloudFileEntry,
  type CloudFilesCode,
  CloudFilesError,
  hasHostedAgent,
} from "../pages/files/cloudFiles";

/**
 * Switch web's side of Core's owner-only `/gateway/cloud-files` routes, with
 * the session cookie. Core picks the box from the signed-in user; the page
 * sends only a box-relative path. Every query is built with URLSearchParams.
 */

const BASE = "/gateway/cloud-files";

/** Waits before each retry of `503 files_elsewhere`: three tries after the first. */
export const FILES_ELSEWHERE_BACKOFF_MS = [300, 800, 2000] as const;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A refused response as a code-only error, from its `{"detail": {"code"}}` body. */
async function refusal(response: Response): Promise<CloudFilesError> {
  const body = (await response.json().catch(() => null)) as { detail?: { code?: unknown } } | null;
  const code = body?.detail?.code;
  if (typeof code === "string" && (CLOUD_FILES_CODES as readonly string[]).includes(code))
    return new CloudFilesError(code as CloudFilesCode, response.status);
  if (response.status === 503) return new CloudFilesError("files_elsewhere", 503);
  return new CloudFilesError("unknown", response.status);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { ...init, credentials: "include" });
  } catch {
    throw new CloudFilesError("unreachable");
  }
}

/** Runs `call`, retrying `503 files_elsewhere` three times with backoff, then "Couldn't reach your cloud". */
export async function withFilesElsewhereRetry<T>(call: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const elsewhere = error instanceof CloudFilesError && error.code === "files_elsewhere";
      if (!elsewhere) throw error;
      const wait = FILES_ELSEWHERE_BACKOFF_MS[attempt];
      if (wait === undefined) throw new CloudFilesError("unreachable", 503);
      await sleep(wait);
    }
  }
}

function isEntry(value: unknown): value is CloudFileEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    (entry.kind === "file" || entry.kind === "folder") &&
    typeof entry.size === "number" &&
    Number.isFinite(entry.size) &&
    entry.size >= 0 &&
    // A time the page can show: `new Date(...).toISOString()` throws past this.
    typeof entry.mtime === "number" &&
    Number.isFinite(entry.mtime) &&
    entry.mtime >= 0 &&
    entry.mtime <= 8.64e15 &&
    (entry.collapsed === undefined || typeof entry.collapsed === "boolean") &&
    (entry.label === undefined || typeof entry.label === "string") &&
    (entry.agent === undefined || typeof entry.agent === "string")
  );
}

/** One page of a folder. `path` is box-relative; '' is the top level. */
export async function listCloudFiles(
  path: string,
  cursor?: string,
  sleep?: Sleep,
): Promise<{ entries: CloudFileEntry[]; cursor?: string }> {
  return withFilesElsewhereRetry(async () => {
    const query = new URLSearchParams({ path });
    if (cursor) query.set("cursor", cursor);
    const response = await send(`${BASE}/list?${query.toString()}`);
    if (!response.ok) throw await refusal(response);
    const body = (await response.json().catch(() => null)) as { entries?: unknown; cursor?: unknown } | null;
    if (!body || !Array.isArray(body.entries)) throw new CloudFilesError("bad_reply");
    return {
      entries: body.entries.filter(isEntry),
      ...(typeof body.cursor === "string" && body.cursor ? { cursor: body.cursor } : {}),
    };
  }, sleep);
}

function parseContentRange(header: string | null): { start: number; total: number } | null {
  if (!header) return null;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (range) return { start: Number(range[1]), total: Number(range[3]) };
  const end = /^bytes \*\/(\d+)$/.exec(header.trim());
  if (end) return { start: -1, total: Number(end[1]) };
  return null;
}

/** One 128 KiB range from `offset`: 206 with Content-Range, 416 at the end, an empty 200 for an empty file. */
export async function readCloudFileRange(
  path: string,
  offset: number,
  sleep?: Sleep,
): Promise<{ done: false; bytes: Uint8Array; total: number } | { done: true; total: number }> {
  return withFilesElsewhereRetry(async () => {
    const query = new URLSearchParams({ path, offset: String(offset) });
    const response = await send(`${BASE}/content?${query.toString()}`);
    const range = parseContentRange(response.headers.get("content-range"));
    if (response.status === 416) {
      if (!range || range.start !== -1) throw new CloudFilesError("bad_reply", 416);
      return { done: true, total: range.total };
    }
    if (!response.ok) throw await refusal(response);
    if (response.status === 200 && offset === 0 && !range) {
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength === 0) return { done: true, total: 0 };
      throw new CloudFilesError("bad_reply", 200);
    }
    if (response.status !== 206 || !range || range.start !== offset) throw new CloudFilesError("bad_reply", response.status);
    return { done: false, bytes: new Uint8Array(await response.arrayBuffer()), total: range.total };
  }, sleep);
}

/** A whole file, read range by range: at most `max` bytes (25 MB by default), refused on the first range if larger. */
export async function readCloudFile(path: string, max: number = CLOUD_FILE_MAX_BYTES, sleep?: Sleep): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const range = await readCloudFileRange(path, offset, sleep);
    if (range.done) break;
    if (range.total > max) throw new CloudFilesError("too_large", 413);
    if (range.bytes.byteLength === 0) {
      if (offset >= range.total) break;
      throw new CloudFilesError("bad_reply");
    }
    parts.push(range.bytes);
    offset += range.bytes.byteLength;
    if (offset > range.total) throw new CloudFilesError("bad_reply");
    if (offset === range.total) break;
  }
  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The address a folder's zip downloads from (it's already `attachment`, so plain navigation saves it). */
export function zipUrl(path: string, caches: boolean): string {
  const query = new URLSearchParams({ path, caches: caches ? "1" : "0" });
  return `${BASE}/zip?${query.toString()}`;
}

/**
 * The agent ids on the signed-in person's v2 box (`GET /gateway/hosted-machines`),
 * or an empty list when there's no box or it can't be read.
 */
export async function fetchBoxAgentIds(): Promise<string[]> {
  try {
    const response = await fetch("/gateway/hosted-machines", { credentials: "include" });
    if (!response.ok) return [];
    const body = (await response.json()) as { machines?: unknown };
    if (!Array.isArray(body.machines)) return [];
    const machines = body.machines as Parameters<typeof hasHostedAgent>[0];
    if (!hasHostedAgent(machines)) return [];
    return (body.machines as { backend?: unknown; state?: unknown; agents?: unknown }[])
      .filter((machine) => machine.backend === "box" && machine.state !== "deleted" && Array.isArray(machine.agents))
      .flatMap((machine) => (machine.agents as unknown[]).filter((id): id is string => typeof id === "string"));
  } catch {
    return [];
  }
}

/** The person's "Wake it": asks Core for the box (`POST /gateway/hosted-machines/ensure`), through the origin check. */
export async function wakeBox(): Promise<void> {
  const response = await fetch("/gateway/hosted-machines/ensure", { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error("wake_failed");
}
