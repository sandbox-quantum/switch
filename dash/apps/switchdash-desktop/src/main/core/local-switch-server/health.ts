import { log } from '@main/lib/logger';

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });

/**
 * Poll the Switch core until its gateway answers, so we only register the server
 * once it can actually serve requests. `/gateway/auth/config` is unauthenticated
 * and cheap, so it is the readiness probe. Returns true once healthy, false on
 * timeout. Honours `signal` so a stop/cancel aborts the wait.
 */
export async function waitForHealth(
  apiUrl: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const url = `${apiUrl}/gateway/auth/config`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await sleep(POLL_INTERVAL_MS, opts.signal);
  }
  log.warn(`local-switch-server: health check timed out after ${timeoutMs}ms`);
  return false;
}
