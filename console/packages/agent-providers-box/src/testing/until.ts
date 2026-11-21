/**
 * Waiting on a host without a clock. A test's fakes call `changed()` whenever
 * the host does something they can see (a message to its parent, a call to
 * its provider, a request to Switch, an event it published), and `until`
 * looks at its check again only then. Nothing polls and no wait has a
 * deadline of its own: a slow disk makes a test slower, not red, and the
 * test's timeout is the one clock left.
 */

type Wait = { wake: () => void; lastError: unknown };

const waits = new Set<Wait>();

/** Something a test can observe has changed: every pending `until` looks again. */
export function changed(): void {
  for (const wait of [...waits]) wait.wake();
}

/**
 * Settles with `check`'s value once it stops throwing, looking again after
 * each `changed()`. A check that reads state nothing announces (a file the
 * host writes, say) never wakes up again; poll those with `vi.waitFor`. A
 * check must only look: one that asks the host for something wakes itself
 * with the answer, and looks again forever.
 */
export function until<T>(check: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let looking = false;
    let again = false;
    const wait: Wait = {
      lastError: undefined,
      wake: () => {
        if (looking) {
          again = true;
          return;
        }
        looking = true;
        void (async () => {
          do {
            again = false;
            try {
              const value = await check();
              waits.delete(wait);
              resolve(value);
              return;
            } catch (error) {
              wait.lastError = error;
            }
          } while (again);
          looking = false;
        })();
      },
    };
    waits.add(wait);
    wait.wake();
  });
}

/**
 * Forgets every wait still pending, and throws what the first of them last
 * saw: a test that ran out of time then says what it was waiting for, as
 * `vi.waitFor` would. Call it from `afterEach`.
 */
export function abandonWaits(): void {
  const pending = [...waits];
  waits.clear();
  const [first] = pending;
  if (!first) return;
  throw new Error(`Still waiting when the test ended: ${String(first.lastError)}`, {
    cause: first.lastError,
  });
}

/**
 * `adapter` as a host sees it, calling `changed()` after each of its methods
 * runs and again when one that returns a promise settles. The test keeps the
 * original, so its mocks still record every call.
 */
export function announcing<T extends object>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        changed();
        if (result instanceof Promise) void result.finally(changed).catch(() => {});
        return result;
      };
    },
  });
}
