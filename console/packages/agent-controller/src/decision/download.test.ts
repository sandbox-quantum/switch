import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fetch } from '../api';
import { FakeDownloads, fakeBytes, sha256 } from '../testing/fake-decision';
import type { Artifact } from './catalogue';
import { ChecksumMismatch, DownloadFailed, downloadArtifact } from './download';

const URL = 'https://models.example.org/weights.gguf';
const bytes = fakeBytes('weights', 100_000);
const artifact: Artifact = { url: URL, sha256: sha256(bytes), bytes: bytes.length };

let dir: string;
let target: string;
let part: string;
let downloads: FakeDownloads;
let progress: number[];

function download(overrides: { fetch?: Fetch; artifact?: Artifact; stallTimeoutMs?: number } = {}) {
  return downloadArtifact({
    fetch: overrides.fetch ?? downloads.fetch,
    artifact: overrides.artifact ?? artifact,
    target,
    part,
    signal: new AbortController().signal,
    onProgress: (done) => void progress.push(done),
    stallTimeoutMs: overrides.stallTimeoutMs ?? 2_000,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-download-'));
  target = join(dir, `${artifact.sha256}.gguf`);
  part = join(dir, `${artifact.sha256}.part`);
  downloads = new FakeDownloads(new Map([[URL, bytes]]));
  progress = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('downloadArtifact', () => {
  it('downloads through the partial file, checks the SHA-256, then renames it', async () => {
    await download();
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(existsSync(part)).toBe(false);
    expect(downloads.requests).toEqual([{ url: URL, range: null }]);
    expect(progress.at(-1)).toBe(bytes.length);
  });

  it('resumes an interrupted download from the bytes it holds, with a range request', async () => {
    downloads.cutAfter.set(URL, 30_000);
    await expect(download()).rejects.toBeInstanceOf(DownloadFailed);
    expect(readFileSync(part).length).toBe(30_000);
    expect(existsSync(target)).toBe(false);

    progress = [];
    await download();
    expect(downloads.requests.at(-1)).toEqual({ url: URL, range: 'bytes=30000-' });
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(progress[0]).toBe(30_000);
    expect(existsSync(part)).toBe(false);
  });

  it('starts over when the server ignores the range', async () => {
    writeFileSync(part, bytes.subarray(0, 10_000));
    downloads.ignoreRanges = true;
    await download();
    expect(readFileSync(target).equals(bytes)).toBe(true);
  });

  it('deletes a file whose SHA-256 is not the pinned one, and says so', async () => {
    downloads.corrupt.add(URL);
    const error = await download().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChecksumMismatch);
    expect((error as ChecksumMismatch).expected).toBe(artifact.sha256);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('takes a file already downloaded at its pinned size without asking again', async () => {
    writeFileSync(target, bytes);
    await download();
    expect(downloads.requests).toEqual([]);
    expect(progress).toEqual([bytes.length]);
  });

  it('gives a stalled download up, keeping what arrived', async () => {
    const stalled: Fetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes.subarray(0, 1_000)));
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
        { status: 200 }
      );
    const error = await download({ fetch: stalled, stallTimeoutMs: 50 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(DownloadFailed);
    expect(String((error as Error).message)).toContain('sent nothing');
    expect(readFileSync(part).length).toBe(1_000);
  });

  it('refuses a URL that is not https', async () => {
    await expect(
      download({ artifact: { ...artifact, url: 'http://models.example.org/weights.gguf' } })
    ).rejects.toThrow(/https only/);
  });

  it('fails a refused request as a download failure', async () => {
    const refused: Fetch = async () => new Response('nope', { status: 503 });
    await expect(download({ fetch: refused })).rejects.toBeInstanceOf(DownloadFailed);
  });
});
