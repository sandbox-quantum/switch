/**
 * The operating system's release, cut down to what a product question needs.
 *
 * `os.release()` is the kernel's full release string — `23.6.0`,
 * `10.0.22631`, `6.1.0-53-cloud-amd64` — and the tail of it (a Windows build
 * number, a Linux distribution's patch and flavour) narrows down a machine far
 * more than it answers anything about the app. So only the leading number is
 * sent, and on macOS the second as well: the Darwin kernel's major tracks the
 * macOS major and its minor the point release, which is the one detail that
 * decides whether a macOS-specific problem applies.
 *
 * `unknown` when the string does not start with a number, rather than passing
 * an unrecognised string through.
 */
export function coarseOsVersion(platform: NodeJS.Platform, release: string): string {
  const match = /^(\d+)(?:\.(\d+))?/.exec(release);
  if (!match) return 'unknown';
  const [, major, minor] = match;
  if (platform === 'darwin') return `${major}.${minor ?? '0'}`;
  return major;
}
