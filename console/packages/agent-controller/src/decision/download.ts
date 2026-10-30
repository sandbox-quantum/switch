import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import type { Fetch } from '../api';
import type { Artifact } from './catalogue';

/** The file downloaded in full is not the one pinned. Its partial copy is deleted. */
export class ChecksumMismatch extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`${url} downloaded with SHA-256 ${actual}, not the pinned ${expected}; it was deleted.`);
  }
}

/** The download stopped short (the network, the server); what arrived is kept to resume from. */
export class DownloadFailed extends Error {}

/** No bytes for this long and the download is given up, to be resumed later. */
export const STALL_TIMEOUT_MS = 60_000;

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(path: string, hash: Hash, signal: AbortSignal): Promise<void> {
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
}

/**
 * Downloads `artifact` to `target`, through `part`: an interrupted download
 * resumes from what `part` already holds, with an HTTP range request (a
 * server that ignores it starts the file over). Once every byte is there the
 * file's SHA-256 must be the pinned one: then `part` is renamed to `target`;
 * otherwise it is deleted and `ChecksumMismatch` thrown. A `target` already
 * there at its pinned size is taken as it is, since only a verified file is
 * ever renamed to it.
 *
 * `onProgress` hears the bytes held so far, resumed ones included.
 */
export async function downloadArtifact(input: {
  fetch: Fetch;
  artifact: Artifact;
  target: string;
  part: string;
  signal: AbortSignal;
  onProgress: (doneBytes: number) => void;
  stallTimeoutMs?: number;
}): Promise<void> {
  const { artifact, target, part, signal } = input;
  if (new URL(artifact.url).protocol !== 'https:')
    throw new Error(
      `Decision model files are downloaded over https only, not from ${artifact.url}.`
    );
  if ((await sizeOf(target)) === artifact.bytes) {
    input.onProgress(artifact.bytes);
    return;
  }
  let held = (await sizeOf(part)) ?? 0;
  if (held > artifact.bytes) {
    await rm(part, { force: true });
    held = 0;
  }
  let hash = createHash('sha256');
  if (held > 0) await hashFile(part, hash, signal);
  input.onProgress(held);
  if (held < artifact.bytes) {
    const stall = new AbortController();
    const stallMs = input.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), stallMs);
    };
    touch();
    const response = await input
      .fetch(artifact.url, {
        headers: held > 0 ? { Range: `bytes=${held}-` } : {},
        signal: AbortSignal.any([signal, stall.signal]),
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        if (signal.aborted) throw error;
        throw new DownloadFailed(`Could not reach ${artifact.url}: ${String(error)}`, {
          cause: error,
        });
      });
    if (held > 0 && response.status === 200) {
      // The server ignored the range: it sends the whole file again.
      held = 0;
      hash = createHash('sha256');
    } else if (!(response.status === 206 || (held === 0 && response.status === 200))) {
      clearTimeout(timer);
      await response.body?.cancel();
      if (response.status === 416) await rm(part, { force: true });
      throw new DownloadFailed(`Downloading ${artifact.url} answered ${response.status}.`);
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new DownloadFailed(`Downloading ${artifact.url} sent no body.`);
    }
    const handle = await open(part, held === 0 ? 'w' : 'a', 0o600);
    try {
      touch();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        touch();
        if (held + chunk.byteLength > artifact.bytes)
          throw new DownloadFailed(`${artifact.url} sent more than its ${artifact.bytes} bytes.`);
        hash.update(chunk);
        await handle.write(chunk);
        held += chunk.byteLength;
        input.onProgress(held);
      }
    } catch (error) {
      if (signal.aborted || error instanceof DownloadFailed) throw error;
      throw new DownloadFailed(
        stall.signal.aborted
          ? `${artifact.url} sent nothing for ${Math.round(stallMs / 1000)} s.`
          : `Downloading ${artifact.url} stopped: ${String(error)}`,
        { cause: error }
      );
    } finally {
      clearTimeout(timer);
      await handle.close();
    }
    if (held < artifact.bytes)
      throw new DownloadFailed(
        `${artifact.url} ended after ${held} of its ${artifact.bytes} bytes.`
      );
  }
  const actual = hash.digest('hex');
  if (actual !== artifact.sha256) {
    await rm(part, { force: true });
    throw new ChecksumMismatch(artifact.url, artifact.sha256, actual);
  }
  await rename(part, target);
}
