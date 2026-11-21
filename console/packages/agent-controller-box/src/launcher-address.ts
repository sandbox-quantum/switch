/**
 * Where the controller listens for the launcher, and the launcher
 * connects. Under gVisor a Unix socket isn't shared between the two
 * containers (split test pod v3.7), so a box uses loopback inside its pod:
 * `127.0.0.1:<port>`, and nothing else. The pod's own address, every other
 * interface and IPv6 are refused. A Unix socket
 * path is still taken where it works (outside gVisor, and in tests).
 */

export type LauncherAddress = { kind: 'path'; path: string } | { kind: 'loopback'; port: number };

const LOOPBACK = /^127\.0\.0\.1:(\d{1,5})$/;

/** `127.0.0.1:<port>` as an address, or null for anything else (another host, `0.0.0.0`, `::`, a bad port). */
export function parseLoopback(value: string): LauncherAddress | null {
  const match = LOOPBACK.exec(value);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? { kind: 'loopback', port } : null;
}

/** The address for `net.connect` and `server.listen`: a path, or 127.0.0.1 and a port, never another host. */
export function netOptions(
  address: LauncherAddress
): { path: string } | { host: '127.0.0.1'; port: number } {
  return address.kind === 'path'
    ? { path: address.path }
    : { host: '127.0.0.1', port: address.port };
}

const PROXY_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/**
 * Whether loopback is kept off any proxy: when a proxy variable is
 * set, `NO_PROXY` (or `no_proxy`) must name `127.0.0.1` or `localhost`, so
 * nothing on the box sends a loopback connection to the egress proxy. True
 * when no proxy is set at all.
 */
export function loopbackOffProxy(env: NodeJS.ProcessEnv): boolean {
  if (!PROXY_VARS.some((name) => (env[name] ?? '') !== '')) return true;
  const noProxy = `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
    .split(',')
    .map((entry) => entry.trim().toLowerCase());
  return noProxy.includes('127.0.0.1') || noProxy.includes('localhost');
}
