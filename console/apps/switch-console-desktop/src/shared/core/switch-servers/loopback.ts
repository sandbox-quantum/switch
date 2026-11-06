/** This computer's own addresses, as a URL's `hostname` gives them. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether `url` is safe to send a sign-in or a secret over: https anywhere, or
 * plain http to this computer itself, where nothing in between can read it.
 * A server Console runs on this computer is on http://127.0.0.1.
 */
export function isHttpsOrLoopback(url: URL): boolean {
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/** Whether `url` names this computer itself, so only programs on it can reach it there. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
