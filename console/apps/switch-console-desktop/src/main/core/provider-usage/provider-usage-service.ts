import type {
  ProviderSubscriptionUsageResult,
  ProviderSubscriptionUsageSnapshot,
  ReadSubscriptionUsage,
  SubscriptionUsageInput,
} from '@switch-console/agent-providers';
import { z } from 'zod';
import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';

const POLL_INTERVAL_MS = 5 * 60_000;
const RESUME_DELAY_MS = 3_000;
const MANUAL_COOLDOWN_MS = 5_000;
const MAX_CONCURRENT = 3;

const timestamp = z.number().nonnegative().max(8.64e15);
const windowFields = {
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().nullable(),
  resetsAt: timestamp.nullable(),
};
const snapshotSchema = z.object({
  providerId: z.string(),
  status: z.enum(['idle', 'fetching', 'ok', 'unauthenticated', 'unavailable', 'error']),
  source: z.enum(['rpc', 'cli', 'oauth', 'api']).optional(),
  planLabel: z.string().nullish(),
  windows: z.array(z.object({ ...windowFields, id: z.string(), label: z.string() })),
  buckets: z
    .array(
      z.object({
        ...windowFields,
        name: z.string(),
        group: z.string().optional(),
        unlimited: z.boolean().optional(),
        remainingCount: z.number().optional(),
        totalCount: z.number().optional(),
      })
    )
    .optional(),
  extraUsage: z
    .object({
      unit: z.enum(['currency', 'credits']),
      enabled: z.boolean(),
      balance: z.number().nullish(),
      spent: z.number().nullish(),
      limit: z.number().nullish(),
      currencyCode: z.string().optional(),
      unlimited: z.boolean().optional(),
      resetsAt: timestamp.nullish(),
    })
    .nullish(),
  message: z.string().nullish(),
  updatedAt: timestamp.nullable(),
  retryAt: timestamp.nullish(),
});

export interface UsageTarget {
  id: string;
  binaryPath: string;
  read?: ReadSubscriptionUsage | undefined;
}

interface Dependencies {
  targets(): UsageTarget[];
  context(): Pick<SubscriptionUsageInput, 'cwd' | 'env'>;
  publish(state: ProviderUsageState): void;
}

interface RefreshJob {
  target: UsageTarget & { read: ReadSubscriptionUsage };
  abort: AbortController;
  done: Promise<void>;
  finish(): void;
}

interface CachedReading {
  snapshot: ProviderSubscriptionUsageSnapshot;
  accountFingerprint?: string | null | undefined;
}

export class ProviderUsageService {
  private enabled = false;
  private active = false;
  private disposed = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private resume: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private targets = new Map<string, UsageTarget>();
  private readings = new Map<string, CachedReading>();
  private running = new Map<string, RefreshJob>();
  private pending = new Map<string, RefreshJob>();
  private retry = new Map<string, { path: string; at: number }>();
  private manual = new Map<string, number>();

  constructor(private readonly dependencies: Dependencies) {}

  private get watching(): boolean {
    return this.enabled && this.active && !this.disposed;
  }

  getSnapshots(): ProviderUsageState {
    return {
      revision: this.revision,
      installedProviderIds: [...this.targets.keys()],
      refreshingProviderIds: [...this.targets.keys()].filter((id) => this.isRefreshing(id)),
      snapshots: [...this.targets.values()].flatMap(({ id, read }) => {
        if (!read) return [];
        return [
          this.readings.get(id)?.snapshot ?? {
            providerId: id,
            status: this.isRefreshing(id) ? 'fetching' : 'idle',
            windows: [],
            updatedAt: null,
            retryAt: this.retry.get(id)?.at,
          },
        ];
      }),
    };
  }

  setEnabled(enabled: boolean): void {
    const wasWatching = this.watching;
    this.enabled = enabled;
    this.updateActivity(wasWatching);
  }

  setActive(active: boolean): void {
    const wasWatching = this.watching;
    this.active = active;
    this.updateActivity(wasWatching);
  }

  private updateActivity(wasWatching: boolean): void {
    if (this.watching === wasWatching) return;
    if (this.watching) {
      this.poll = setInterval(() => void this.requestRefresh(), POLL_INTERVAL_MS);
      void this.requestRefresh();
    } else {
      clearInterval(this.poll);
      clearTimeout(this.resume);
      this.resume = undefined;
      for (const id of this.targets.keys()) this.invalidate(id);
      this.targets.clear();
      this.emit();
    }
  }

  dispose(): void {
    const wasWatching = this.watching;
    this.disposed = true;
    this.updateActivity(wasWatching);
    this.retry.clear();
    this.manual.clear();
  }

  handleSystemResume(): void {
    if (!this.watching) return;
    clearTimeout(this.resume);
    this.resume = setTimeout(() => void this.requestRefresh(), RESUME_DELAY_MS);
  }

  handleLoginExit({
    providerId,
    exitCode,
    error,
  }: {
    providerId: string;
    exitCode: number | null;
    error: string | null;
  }): void {
    if (exitCode !== 0 || error) return;
    this.invalidate(providerId);
    this.retry.delete(providerId);
    this.manual.delete(providerId);
    if (this.watching) void this.requestRefresh(providerId);
  }

  handleDependenciesChanged(): void {
    if (!this.watching) return;
    const previous = this.targets;
    const changed = this.reconcile();
    const added = [...this.targets.values()].filter(
      ({ id, binaryPath, read }) => read && previous.get(id)?.binaryPath !== binaryPath
    );
    if (changed) this.emit();
    for (const { id } of added) void this.requestRefresh(id);
  }

  async refresh(providerId?: string): Promise<ProviderUsageState> {
    await this.requestRefresh(providerId, true);
    return this.getSnapshots();
  }

  private isRefreshing(id: string): boolean {
    return this.pending.has(id) || this.running.get(id)?.abort.signal.aborted === false;
  }

  private emit(): void {
    this.revision++;
    this.dependencies.publish(this.getSnapshots());
  }

  private invalidate(id: string): void {
    this.running.get(id)?.abort.abort();
    const queued = this.pending.get(id);
    this.pending.delete(id);
    queued?.finish();
    this.readings.delete(id);
  }

  private reconcile(): boolean {
    const next = new Map(this.dependencies.targets().map((target) => [target.id, target]));
    let changed = next.size !== this.targets.size;
    for (const [id, previous] of this.targets) {
      if (next.get(id)?.binaryPath === previous.binaryPath) continue;
      this.invalidate(id);
      this.retry.delete(id);
      this.manual.delete(id);
      changed = true;
    }
    this.targets = next;
    return changed;
  }

  private requestRefresh(providerId?: string, manual = false): Promise<void> {
    if (!this.watching) return Promise.resolve();
    const changed = this.reconcile();
    const jobs: Promise<void>[] = [];
    const now = Date.now();
    let queued = false;
    for (const target of this.targets.values()) {
      const { id, binaryPath, read } = target;
      if (!read || (providerId !== undefined && id !== providerId)) continue;
      const existing = this.pending.get(id) ?? this.running.get(id);
      if (existing && !existing.abort.signal.aborted) {
        jobs.push(existing.done);
        continue;
      }
      const retry = this.retry.get(id);
      if (retry?.path === binaryPath && now < retry.at) continue;
      if (manual && now < (this.manual.get(id) ?? 0)) continue;
      const { promise, resolve } = Promise.withResolvers<void>();
      const job = {
        target: { ...target, read },
        abort: new AbortController(),
        done: promise,
        finish: resolve,
      };
      this.pending.set(id, job);
      jobs.push(promise);
      if (manual) this.manual.set(id, now + MANUAL_COOLDOWN_MS);
      queued = true;
    }
    if (changed || queued || providerId !== undefined) this.emit();
    this.drain();
    return Promise.all(jobs).then(() => {});
  }

  private drain(): void {
    if (!this.watching) return;
    for (const [id, job] of this.pending) {
      if (this.running.size >= MAX_CONCURRENT) break;
      if (this.running.has(id)) continue;
      this.pending.delete(id);
      this.running.set(id, job);
      void this.run(job);
    }
  }

  private async run(job: RefreshJob): Promise<void> {
    const { id, binaryPath, read } = job.target;
    const signal = job.abort.signal;
    try {
      let result: ProviderSubscriptionUsageResult | undefined;
      try {
        result = await read({ ...this.dependencies.context(), binaryPath, signal });
        if (signal.aborted) return;
        this.accept(id, binaryPath, result);
      } catch {
        if (signal.aborted) return;
        this.accept(id, binaryPath, {
          providerId: id,
          status: 'error',
          windows: [],
          updatedAt: null,
          message: 'Could not read subscription usage.',
          accountFingerprint: result?.accountFingerprint,
        });
      }
    } finally {
      this.running.delete(id);
      job.finish();
      if (this.watching && !signal.aborted) this.emit();
      this.drain();
    }
  }

  private accept(id: string, path: string, result: ProviderSubscriptionUsageResult): void {
    const snapshot: ProviderSubscriptionUsageSnapshot = snapshotSchema.parse({
      ...result,
      providerId: id,
    });
    if (snapshot.retryAt) this.retry.set(id, { path, at: snapshot.retryAt });
    else this.retry.delete(id);

    const previous = this.readings.get(id);
    const changedAccount =
      result.accountFingerprint != null &&
      previous?.accountFingerprint != null &&
      result.accountFingerprint !== previous.accountFingerprint;
    if (snapshot.status === 'error' && previous?.snapshot.status === 'ok' && !changedAccount) {
      this.readings.set(id, {
        accountFingerprint: previous.accountFingerprint,
        snapshot: {
          ...previous.snapshot,
          stale: true,
          staleError: snapshot.message,
          retryAt: snapshot.retryAt,
        },
      });
      return;
    }
    this.readings.set(id, { accountFingerprint: result.accountFingerprint, snapshot });
  }
}
