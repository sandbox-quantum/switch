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

class UsageCommandError extends Error {
  constructor(readonly exitStatus: 'signed-out' | 'rate-limited' | 'unknown') {
    super('Antigravity usage command failed.');
  }
}

function run(input: SubscriptionUsageInput, args: string[], timeout: number): Promise<string> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeout)]);
  signal.throwIfAborted();
  const child = spawnProvider(input.binaryPath, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let stopped: Error | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = new UsageCommandError('unknown');
      stopProvider(child, 'SIGKILL');
    };
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutput) stop();
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(new UsageCommandError('unknown'));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (stopped) reject(stopped);
      else if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else if (/\b429\b|too many requests/i.test(stderr))
        reject(new UsageCommandError('rate-limited'));
      else if (/\b401\b|authentication required|not signed in/i.test(stderr))
        reject(new UsageCommandError('signed-out'));
      else reject(new UsageCommandError('unknown'));
    });
  });
}

async function supportedVersion(input: SubscriptionUsageInput): Promise<boolean> {
  const { ino, size, mtimeMs, ctimeMs } = await stat(input.binaryPath);
  const executable = `${ino}:${size}:${mtimeMs}:${ctimeMs}`;
  if (verifiedVersions.get(input.binaryPath) === executable) return true;
  const match = (await run(input, ['--version'], 5_000)).match(versionLine);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supported = major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
  // An in-place update can make a previously unsupported CLI usable.
  if (supported) verifiedVersions.set(input.binaryPath, executable);
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
      return unavailable('Antigravity CLI 1.1.11 or newer is required to read subscription usage.');
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
    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      payload = null;
    }
    const envelope = envelopeSchema.safeParse(payload);
    if (
      !envelope.success ||
      envelope.data.num_turns !== 0 ||
      envelope.data.usage.total_tokens !== 0 ||
      envelope.data.command.name !== 'usage'
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
