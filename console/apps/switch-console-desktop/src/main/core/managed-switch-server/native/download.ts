import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { resolveExecutable, windowsInstallPath } from "@main/core/utils/resolve-executable";
import type { PinnedArchive } from "./toolchain-pins";

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/** The digest `integrity` names, in the encoding it is written in. */
function parseIntegrity(integrity: string): {
  algorithm: string;
  digest: string;
  encoding: "hex" | "base64";
} {
  if (integrity.startsWith("sha256:")) {
    return { algorithm: "sha256", digest: integrity.slice("sha256:".length), encoding: "hex" };
  }
  const dash = integrity.indexOf("-");
  if (dash === -1) throw new Error(`Unrecognised integrity value: ${integrity}`);
  return {
    algorithm: integrity.slice(0, dash),
    digest: integrity.slice(dash + 1),
    encoding: "base64",
  };
}

/**
 * Download `url` to `destination`, refusing it unless its digest matches
 * `integrity` (or, with `integrity` null, keeping it unverified — for a source
 * archive whose content is only known by its tag). Written to a temporary name
 * first, so an interrupted download never leaves a file that looks complete.
 */
export async function downloadFile(
  url: string,
  destination: string,
  integrity: string | null,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || response.body === null) {
    throw new Error(`Downloading ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  const expected = integrity === null ? null : parseIntegrity(integrity);
  const hash = expected === null ? null : createHash(expected.algorithm);
  const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  if (hash !== null) body.on("data", (chunk: Buffer) => hash.update(chunk));
  try {
    await pipeline(body, createWriteStream(partial, { mode: 0o600 }));
    if (expected !== null && hash !== null) {
      const actual = hash.digest(expected.encoding);
      if (actual !== expected.digest) {
        throw new Error(
          `The download from ${url} does not match its pinned checksum, so it was not used ` +
            `(expected ${expected.algorithm} ${expected.digest}, got ${actual}).`,
        );
      }
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * The `tar` this machine has. Every platform Console ships on carries one:
 * bsdtar on macOS and on Windows 10 and later (which also reads zip), GNU tar
 * on Linux.
 */
export function tarExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveExecutable("tar", {
    candidates: [
      "/usr/bin/tar",
      "/bin/tar",
      windowsInstallPath(env, "SystemRoot", "System32", "tar.exe") ?? "",
    ].filter(Boolean),
    env,
  });
}

/**
 * Unpack `archive` into `destination`, replacing anything already there. The
 * archive is extracted into a sibling directory and moved into place only once
 * it has fully unpacked, so a failure never leaves half a toolchain behind
 * under the name the next start would trust.
 */
export async function extractArchive(
  archive: string,
  destination: string,
  stripComponents: number,
): Promise<void> {
  const staging = `${destination}.extracting`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const args = ["-xf", archive, "-C", staging];
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
  try {
    await execFileAsync(tarExecutable(), args, {
      timeout: EXTRACT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not unpack ${path.basename(archive)}: ${detail}`);
  }
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
}

/** Download a pinned archive and unpack it into `destination`. */
export async function installPinnedArchive(
  archive: PinnedArchive,
  downloadsDir: string,
  destination: string,
): Promise<void> {
  const file = path.join(downloadsDir, path.basename(new URL(archive.url).pathname));
  try {
    await downloadFile(archive.url, file, archive.integrity);
    await extractArchive(file, destination, archive.stripComponents);
  } finally {
    await rm(file, { force: true });
  }
}
