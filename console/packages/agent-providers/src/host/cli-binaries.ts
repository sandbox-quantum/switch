import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CliTool } from './service-access';

/** The largest archive a pinned build may be. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const EXTRACT_TIMEOUT_MS = 2 * 60_000;
const STATUS_FILE = 'status.json';

/**
 * Where this machine keeps the vendor tools its sessions run, one folder per
 * build named by its archive's SHA-256, beside the sessions' own state.
 */
export function cliToolsBase(): string {
  return join(homedir(), '.local', 'state', 'switch', 'tools');
}

const toolRecordSchema = z.object({
  version: z.string(),
  target: z.string(),
  state: z.enum(['ok', 'unsupported', 'failed']),
  detail: z.string().nullable(),
  checked_at: z.string(),
});
type ToolRecord = z.infer<typeof toolRecordSchema>;
const statusSchema = z.record(z.string(), toolRecordSchema);

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/**
 * What sessions here last found of each vendor tool: installed, failed, or
 * without a build for this machine, which the agents controller reports.
 */
async function record(base: string, binary: string, entry: ToolRecord): Promise<void> {
  const path = join(base, STATUS_FILE);
  let all: Record<string, ToolRecord> = {};
  try {
    all = statusSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`The vendor tools' status file is unreadable and is written afresh: ${error}`);
  }
  all[binary] = entry;
  await mkdir(base, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(4).toString('hex')}`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Each vendor tool sessions here have set up, as the controller's status names tools. */
export async function readCliToolStatuses(
  base: string
): Promise<{ tool: string; state: 'ok' | 'missing' | 'unsupported' }[]> {
  let raw: string;
  try {
    raw = await readFile(join(base, STATUS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = statusSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`The vendor tools' status file is not as written.`);
  return Object.entries(parsed.data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, entry]) => ({
      tool,
      state: entry.state === 'failed' ? 'missing' : entry.state,
    }));
}

/** The archive at `url`, saved to `path` only if its SHA-256 is `sha256`. */
async function download(
  url: string,
  path: string,
  sha256: string,
  binary: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.url && !response.url.startsWith('https://')) {
    await response.body?.cancel();
    throw new Error(`The download of \`${binary}\` was sent somewhere other than HTTPS.`);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`The download of \`${binary}\` failed (HTTP ${response.status}).`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        done(new Error(`The download of \`${binary}\` is larger than ${MAX_ARCHIVE_BYTES} bytes.`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    counted,
    createWriteStream(path, { mode: 0o600 })
  );
  if (hash.digest('hex') !== sha256)
    throw new Error(
      `The download of \`${binary}\` does not match its pinned SHA-256, so it was not used.`
    );
}

/**
 * Finds the pinned build of a vendor tool for this machine, downloading it on
 * first use: the archive for `<platform>-<arch>` is fetched over HTTPS, kept
 * only if its SHA-256 matches the catalog's, and unpacked with the system's
 * `tar` (which reads `.zip` too on Windows) into a folder named by that hash,
 * so a build is installed once per machine and never replaced in place. A
 * machine without a build cannot run the tool, and says so.
 */
export function pinnedBinary(deps: {
  base: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  /** The system's archive tool. */
  tar: string;
}): (tool: CliTool) => Promise<string> {
  const installing = new Map<string, Promise<string>>();
  return async (tool) => {
    const target = `${deps.platform}-${deps.arch}`;
    const now = () => new Date().toISOString();
    const build = tool.release.targets[target];
    if (!build) {
      await record(deps.base, tool.binary, {
        version: tool.release.version,
        target,
        state: 'unsupported',
        detail: null,
        checked_at: now(),
      });
      throw new Error(
        `\`${tool.binary}\` ${tool.release.version} has no build for this machine (${target}).`
      );
    }
    const binary = join(deps.base, tool.binary, build.sha256, ...build.path.split('/'));
    if (await isFile(binary)) return binary;
    const running = installing.get(build.sha256);
    if (running) return running;
    const install = (async () => {
      const parent = join(deps.base, tool.binary);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const work = await mkdtemp(join(parent, '.install-'));
      try {
        const extension = build.url.endsWith('.zip') ? '.zip' : '.tar.gz';
        const archive = join(work, `archive${extension}`);
        await download(build.url, archive, build.sha256, tool.binary, deps.fetch);
        const unpacked = join(work, 'unpacked');
        await mkdir(unpacked);
        await promisify(execFile)(deps.tar, ['-xf', archive, '-C', unpacked], {
          timeout: EXTRACT_TIMEOUT_MS,
        });
        const inside = join(unpacked, ...build.path.split('/'));
        if (!(await isFile(inside)))
          throw new Error(`The \`${tool.binary}\` archive has no ${build.path}.`);
        if (deps.platform !== 'win32') await chmod(inside, 0o755);
        try {
          await rename(unpacked, join(parent, build.sha256));
        } catch (error) {
          // Another session installed the same build first.
          if (!(await isFile(binary))) throw error;
        }
        await record(deps.base, tool.binary, {
          version: tool.release.version,
          target,
          state: 'ok',
          detail: null,
          checked_at: now(),
        });
        return binary;
      } catch (error) {
        await record(deps.base, tool.binary, {
          version: tool.release.version,
          target,
          state: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          checked_at: now(),
        });
        throw error;
      } finally {
        await rm(work, { recursive: true, force: true });
        installing.delete(build.sha256);
      }
    })();
    installing.set(build.sha256, install);
    return install;
  };
}
