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
