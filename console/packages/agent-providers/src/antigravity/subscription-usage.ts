import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderReadiness } from '../readiness';
import {
  clampUsagePercent,
  type ProviderSubscriptionUsageResult,
  type SubscriptionUsageInput,
  type SubscriptionUsageWindow,
} from '../subscription-usage';
import { isAntigravityIdeLauncher, isLegacyAntigravityRuntime } from './runtime';

const envelopeSchema = z.object({
  status: z.string(),
  num_turns: z.number(),
  usage: z.object({ total_tokens: z.number() }),
  command: z.object({ name: z.string(), data: z.unknown() }),
});
const activitySchema = z.object({
  num_turns: z.number().catch(0),
  usage: z
    .object({ total_tokens: z.number().catch(0) })
    .nullish()
    .catch(null),
  conversation_id: z.string().catch(''),
  command: z.object({ name: z.string() }).nullish().catch(null),
});
const usageSchema = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        buckets: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120),
              window: z.string(),
              remaining_fraction: z.number().optional(),
              reset_time: z.string().nullish(),
              disabled: z.boolean().optional(),
            })
          )
          .max(100),
      })
    )
    .max(30),
});

const maxOutput = 512 * 1024;
const verifiedVersions = new Map<string, string>();
const unsafeBinaries = new Set<string>();
const versionLine =
  /^(?:(?:agy|antigravity(?: cli)?)(?: version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+\S+)?$/im;

type ExitStatus = 'ok' | 'signed-out' | 'rate-limited' | 'unknown';

class UsageCommandError extends Error {
  constructor(
    readonly exitStatus: Exclude<ExitStatus, 'ok'>,
    readonly stdout?: string
  ) {
    super('Antigravity usage command failed.');
  }
}

function parseReport(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function hasUsageActivity(payload: unknown): boolean {
  const activity = activitySchema.safeParse(payload).data;
  return Boolean(
    activity &&
    (activity.num_turns > 0 ||
      (activity.usage?.total_tokens ?? 0) > 0 ||
      activity.conversation_id !== '' ||
      (activity.command && activity.command.name !== 'usage'))
  );
}

function hasBufferedActivity(output: string): boolean {
  if (hasUsageActivity(parseReport(output))) return true;
  // A complete report may already have arrived before a final incomplete line.
  return output.split(/\r?\n/).some((line) => {
    const candidate = line.trim();
    return (
      candidate.startsWith('{') &&
      candidate.endsWith('}') &&
      hasUsageActivity(parseReport(candidate))
    );
  });
}

function processStatus(code: number | null, stderr: string): ExitStatus {
  if (code === 0) return 'ok';
  if (/\b429\b|too many requests/i.test(stderr)) return 'rate-limited';
  if (/\b401\b|authentication required|not signed in/i.test(stderr)) return 'signed-out';
  return 'unknown';
}

function run(
  input: SubscriptionUsageInput,
  args: string[],
  timeout: number
): Promise<{ stdout: string; status: ExitStatus }> {
  const { signal } = input;
  signal.throwIfAborted();
  const child = spawnProvider(input.binaryPath, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      return true;
    };
    const stop = () => {
      if (!finish()) return;
      const received = Buffer.concat(stdout).toString('utf8');
      child.stdout?.destroy();
      child.stderr?.destroy();
      // The CLI and its descendants may keep pipes open after the parent
      // exits. Stop the tree without waiting for its close event.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else stopProvider(child, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      reject(new UsageCommandError('unknown', received));
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      const remaining = maxOutput - bytes;
      stdout.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxOutput) stop();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.once('error', () => {
      if (finish()) reject(new UsageCommandError('unknown'));
    });
    child.once('close', (code) => {
      if (finish())
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          status: processStatus(code, stderr),
        });
    });
    if (signal.aborted) stop();
  });
}

async function supportedVersion(input: SubscriptionUsageInput): Promise<boolean> {
  const { ino, size, mtimeMs, ctimeMs } = await stat(input.binaryPath);
  const executable = `${ino}:${size}:${mtimeMs}:${ctimeMs}`;
  // A Windows script can keep the same metadata when its target is replaced.
  const canCache = !/\.(?:bat|cmd|ps1)$/i.test(input.binaryPath);
  if (canCache && verifiedVersions.get(input.binaryPath) === executable) return true;
  const version = await run(input, ['--version'], 5_000);
  if (version.status !== 'ok') throw new UsageCommandError(version.status);
  const match = version.stdout.match(versionLine);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supported = major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 13)));
  // An in-place update can make a previously unsupported CLI usable.
  if (supported && canCache) verifiedVersions.set(input.binaryPath, executable);
  return supported;
}

const bucketWindows = new Map([
  ['5h', { id: '5h', label: '5h', windowMinutes: 300 }],
  ['weekly', { id: '7d', label: '7d', windowMinutes: 10_080 }],
]);

export async function readAntigravitySubscriptionUsage(
  input: SubscriptionUsageInput,
  checkSignIn: (input: SubscriptionUsageInput) => Promise<ProviderReadiness>
): Promise<ProviderSubscriptionUsageResult> {
  const base = {
    providerId: 'antigravity',
    source: 'cli',
    windows: [],
    updatedAt: null,
    planLabel: null,
    accountFingerprint: null,
  } satisfies Partial<ProviderSubscriptionUsageResult>;
  const unavailable = (message: string): ProviderSubscriptionUsageResult => ({
    ...base,
    status: 'unavailable',
    message,
  });
  const signedOut = (): ProviderSubscriptionUsageResult => ({
    ...base,
    status: 'unauthenticated',
    message: 'Sign in to Antigravity to read subscription usage.',
  });
  const { binaryPath, signal } = input;
  signal.throwIfAborted();
  if (isLegacyAntigravityRuntime(binaryPath) || isAntigravityIdeLauncher(binaryPath))
    return unavailable('Install the Antigravity CLI (agy) to read subscription usage.');
  if (unsafeBinaries.has(binaryPath))
    return unavailable('This Antigravity CLI did not return a zero-turn usage report.');

  const { GEMINI_API_KEY, ...credentialEnv } = input.env;
  const env = { ...credentialEnv, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', BROWSER: 'false' };
  try {
    if (!(await supportedVersion({ ...input, env })))
      return unavailable('Antigravity CLI 1.5.13 or newer is required to read subscription usage.');
    const readiness = await checkSignIn({
      ...input,
      env,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    signal.throwIfAborted();
    if (readiness.status === 'unauthenticated')
      return GEMINI_API_KEY
        ? unavailable('API key authentication does not provide Antigravity subscription usage.')
        : signedOut();
    if (readiness.status !== 'authenticated') throw new UsageCommandError('unknown');
    const output = await run(
      { ...input, env },
      ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'],
      25_000
    );
    const payload = parseReport(output.stdout);
    const unexpectedActivity = hasUsageActivity(payload);
    if (unexpectedActivity) unsafeBinaries.add(binaryPath);
    signal.throwIfAborted();
    if (unexpectedActivity)
      return unavailable('This Antigravity CLI did not return a zero-turn usage report.');
    if (output.status !== 'ok') throw new UsageCommandError(output.status);
    const envelope = envelopeSchema.safeParse(payload);
    if (
      !envelope.success ||
      envelope.data.num_turns !== 0 ||
      envelope.data.usage.total_tokens !== 0
    ) {
      unsafeBinaries.add(binaryPath);
      return unavailable('This Antigravity CLI did not return a zero-turn usage report.');
    }
    if (envelope.data.status !== 'SUCCESS') throw new UsageCommandError('unknown');
    const { groups } = usageSchema.parse(envelope.data.command.data);
    const windows = new Map<string, SubscriptionUsageWindow>();
    const buckets = groups.flatMap(({ name: group, buckets }) =>
      buckets.flatMap((bucket) => {
        if (bucket.disabled || bucket.remaining_fraction === undefined) return [];
        const definition = bucketWindows.get(bucket.window);
        const usedPercent = clampUsagePercent(Math.round((1 - bucket.remaining_fraction) * 100));
        const reset = Date.parse(bucket.reset_time ?? '');
        const resetsAt = reset > 0 ? reset : null;
        if (definition && (windows.get(definition.id)?.usedPercent ?? -1) < usedPercent)
          windows.set(definition.id, { ...definition, usedPercent, resetsAt });
        return [
          {
            group,
            name: bucket.name,
            usedPercent,
            windowMinutes: definition?.windowMinutes ?? null,
            resetsAt,
          },
        ];
      })
    );
    return {
      ...base,
      status: 'ok',
      updatedAt: Date.now(),
      buckets,
      windows: [...windows.values()].sort((a, b) => a.windowMinutes! - b.windowMinutes!),
    };
  } catch (error) {
    if (error instanceof UsageCommandError && error.stdout && hasBufferedActivity(error.stdout))
      unsafeBinaries.add(binaryPath);
    signal.throwIfAborted();
    if (error instanceof UsageCommandError && error.exitStatus === 'signed-out') return signedOut();
    if (error instanceof UsageCommandError && error.exitStatus === 'rate-limited')
      return {
        ...base,
        status: 'error',
        message: 'Antigravity is rate limiting usage requests.',
        retryAt: Date.now() + 5 * 60_000,
      };
    return { ...base, status: 'error', message: 'Could not read Antigravity subscription usage.' };
  }
}
