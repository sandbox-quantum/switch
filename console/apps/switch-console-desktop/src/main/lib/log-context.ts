import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mergeLogContext, type LogContext } from '@shared/logger';

/**
 * Ambient log context for the main process.
 *
 * Work started at an entry point (an RPC call, a PTY spawn, a sidecar launch)
 * runs inside a scope carrying the ids that identify it. Code far below can
 * then log without every intermediate signature having to forward a session id
 * it has no other use for.
 *
 * This is deliberately confined to logging: nothing must *behave* differently
 * based on ambient state, only report differently. Ambient state that changes
 * behaviour is invisible coupling and far harder to reason about than a
 * parameter.
 */
const storage = new AsyncLocalStorage<LogContext>();

/** Identifies one app run, so a single launch can be isolated in a rotated log. */
const runId = randomUUID();

export function getRunId(): string {
  return runId;
}

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(mergeLogContext(storage.getStore(), context) ?? context, fn);
}

/**
 * Capture the current scope and re-apply it later.
 *
 * `AsyncLocalStorage` follows promises and timers but not every long-lived
 * emitter: a stream or interval created inside a scope keeps that scope
 * forever, which produces stale attribution once the work it belonged to is
 * gone. Callbacks that outlive their originating operation should be bound
 * explicitly rather than relying on propagation.
 */
export function bindLogContext<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const captured = storage.getStore();
  if (!captured) return fn;
  return (...args: A) => storage.run(captured, () => fn(...args));
}

type LogContextResolver = (context: LogContext) => LogContext | undefined;

const resolvers: LogContextResolver[] = [];

/**
 * Register a function that fills in fields derivable from the ids already on an
 * entry — for example turning a session id into its room and agent.
 *
 * Registration (rather than a direct import) keeps the sink from depending on
 * the services it enriches from, which would otherwise be a cycle: those
 * services log.
 */
export function registerLogContextResolver(resolver: LogContextResolver): void {
  resolvers.push(resolver);
}

/** Test seam; production code registers once at boot. */
export function clearLogContextResolvers(): void {
  resolvers.length = 0;
}

/**
 * Merge ambient context, the entry's own context, and anything the registered
 * resolvers can derive from it.
 *
 * Enrichment is best-effort by construction: a resolver that throws is skipped
 * rather than allowed to take down the write. It must also stay synchronous —
 * a logger that awaits a database read is a logger that deadlocks at shutdown.
 */
export function resolveLogContext(entry: LogContext | undefined): LogContext {
  const resolved: LogContext = {
    runId,
    ...storage.getStore(),
    ...entry,
  };

  for (const resolver of resolvers) {
    try {
      const derived = resolver(resolved);
      if (!derived) continue;

      // Only fill gaps: a value supplied at the call site is more specific than
      // one derived from an id, so it is never overwritten.
      for (const [key, value] of Object.entries(derived)) {
        if (value === undefined) continue;
        if (resolved[key as keyof LogContext] !== undefined) continue;
        Object.assign(resolved, { [key]: value });
      }
    } catch {
      // A broken resolver degrades the context; it must not lose the entry.
    }
  }

  return resolved;
}
