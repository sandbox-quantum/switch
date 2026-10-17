/**
 * The tools a native local server is built from when the machine does not
 * already have them, pinned by version and by checksum.
 *
 * A download that does not match its checksum is refused rather than run: these
 * are executables, fetched over the network, that end up holding the server's
 * data. Moving a pin means moving its checksums with it, taken from the
 * publisher (uv's `.sha256` release assets, the npm registry's `dist.integrity`).
 */

export type PinnedArchive = {
  url: string;
  /** Subresource-integrity form: `<algorithm>-<base64 digest>`, or `sha256:<hex>`. */
  integrity: string;
  /** Leading path components to drop when extracting. */
  stripComponents: number;
};

/** The platform keys the pins are published for. */
export type NativePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-arm64'
  | 'win32-x64';

export function currentNativePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): NativePlatform | null {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'linux-arm64':
    case 'linux-x64':
    case 'win32-arm64':
    case 'win32-x64':
      return key;
    default:
      return null;
  }
}

export const UV_VERSION = '0.13.1';

const UV_TARGETS: Record<NativePlatform, { target: string; sha256: string }> = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin.tar.gz',
    sha256: 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin.tar.gz',
    sha256: 'bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-gnu.tar.gz',
    sha256: 'eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu.tar.gz',
    sha256: '9041c73c99fdc5892cf128140beb354eca9231d502068cc36e6cb53a8e59ad14',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc.zip',
    sha256: '3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672',
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc.zip',
    sha256: 'ec7846a5939b4654afee24f2d82bf6fde71bd7a6952d7748f1135ab301dd0a49',
  },
};

export function uvArchive(platform: NativePlatform): PinnedArchive {
  const { target, sha256 } = UV_TARGETS[platform];
  return {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}`,
    integrity: `sha256:${sha256}`,
    // The tarballs wrap the binaries in a `uv-<target>/` directory; the Windows
    // zip does not.
    stripComponents: platform.startsWith('win32') ? 0 : 1,
  };
}

/**
 * Portable PostgreSQL builds, as packaged for the `embedded-postgres` npm
 * project: a plain gzip tarball per platform with `bin/`, `lib/` and `share/`
 * under `package/native/`, and the shared-library symlinks npm cannot carry
 * listed in `pg-symlinks.json` to be recreated after extraction.
 */
export const POSTGRES_VERSION = '16.14.0-beta.17';
export const POSTGRES_MAJOR = 16;

const POSTGRES_PACKAGES: Partial<Record<NativePlatform, { pkg: string; integrity: string }>> = {
  'darwin-arm64': {
    pkg: 'darwin-arm64',
    integrity:
      'sha512-CB1DFZ08zfmNapx231rAJW74UZfs1jQmeGLwbQSaAIRVs2uqEdMhVNLwVlztFG3ZPSeuCsgTn/0yeYDmKF67og==',
  },
  'darwin-x64': {
    pkg: 'darwin-x64',
    integrity:
      'sha512-zikibpPYGWokfT/OFWNHCwerA3ZGat0ZyCIXOIbIucLBMDHztQ2WZQ9R5zil6oOxzElrMz2Q4aEOssGNrMDdyg==',
  },
  'linux-x64': {
    pkg: 'linux-x64',
    integrity:
      'sha512-8fr7hEiI7XlbPDPsLZJ4RU1NR6jTIDWpf81Sfiwk3T845V0yJJGxjawjkQZmIWVgPW/qY/dMSv0o08FRWJ/zsg==',
  },
  'linux-arm64': {
    pkg: 'linux-arm64',
    integrity:
      'sha512-LNT9TXoOGR/RSop1PewcMtpuf1Dtg6sKU7sFA1ODqInRA8NoP15HyLekUHW5aWnruu4yfs1pcy6DaV39T556mQ==',
  },
  'win32-x64': {
    pkg: 'windows-x64',
    integrity:
      'sha512-Wn4nuAT1H7SIJuLWPs+C1aSdZKpbTloCr0Xaozdfg956lUVvv3iHv6K8Lsc+xmtt1qQpTno3PJLqAgzJ/lg60Q==',
  },
};

/** The portable PostgreSQL build for `platform`, or null where none is
 * published (Windows on Arm). */
export function postgresArchive(platform: NativePlatform): PinnedArchive | null {
  const entry = POSTGRES_PACKAGES[platform];
  if (!entry) return null;
  return {
    url: `https://registry.npmjs.org/@embedded-postgres/${entry.pkg}/-/${entry.pkg}-${POSTGRES_VERSION}.tgz`,
    integrity: entry.integrity,
    // `package/native/{bin,lib,share}` → `{bin,lib,share}`.
    stripComponents: 2,
  };
}

/** Raised when the bundle's layout changes, so a bundle built to an older
 * layout is rebuilt rather than reused (scripts/build-local-server-bundle.mjs). */
export const BUNDLE_FORMAT = 2;

/** The Python switch-core is installed into, fetched by uv when missing. */
export const SWITCH_CORE_PYTHON = '3.12';

/** Source archive of a tagged Switch release. */
export function switchSourceArchiveUrl(owner: string, repo: string, version: string): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/switch-v${version}`;
}
