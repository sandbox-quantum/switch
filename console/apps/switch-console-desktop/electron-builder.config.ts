import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AfterPackContext, Configuration } from 'electron-builder';
import {
  APP_ID,
  APP_NAME_LOWER,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
} from './src/shared/app-identity.ts';

// CI has no Apple Developer cert, so electron-builder is told to skip its own
// signing (CSC_IDENTITY_AUTO_DISCOVERY=false). An unsigned bundle is killed by
// the kernel on Apple Silicon ("Code Signature Invalid"), so we apply a valid
// *ad-hoc* signature to the whole bundle ourselves. Ad-hoc needs no cert; the
// disable-library-validation entitlement lets the ad-hoc-signed nested native
// modules load. This does not remove the Gatekeeper quarantine prompt (that
// needs Developer ID + notarization) — it only makes the app actually launch.
async function adhocSignMac(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      'build/entitlements.mac.plist',
      appPath,
    ],
    { stdio: 'inherit' }
  );
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
}

// Notarize + staple ourselves, with retry, instead of electron-builder's built-in
// `mac.notarize`. Reason: @electron/notarize submits to Apple and then staples the
// ticket in one call, and the staple's online lookup (api.apple-cloudkit.com)
// intermittently drops with NSURLError -1005 ("network connection was lost",
// "staple and validate action failed, Error 68"), failing the whole release. That
// staple runs inside electron-builder, out of reach of the shell-level retry around
// the post-build verify. Here we own the call, so we retry it with backoff.
// Notarization is deduplicated by Apple by content hash, so a retry re-staples in a
// fresh network window without re-doing the slow upload. A genuine failure still
// throws after the attempts are spent — signing and notarization guarantees are
// unchanged, only made resilient to the transient. Runs only when a Developer ID
// cert is present (see `afterSign` below); `mac.notarize` is off so this is the
// single notarization path.
async function notarizeWithRetryMac(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const appleApiKey = process.env.APPLE_API_KEY;
  const appleApiKeyId = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;
  if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
    throw new Error(
      'Notarization is on (a Developer ID cert is present) but APPLE_API_KEY, ' +
        'APPLE_API_KEY_ID and APPLE_API_ISSUER are not all set.'
    );
  }
  const { notarize } = await import('@electron/notarize');
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await notarize({ appPath, appleApiKey, appleApiKeyId, appleApiIssuer });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delayMs = 15_000 * 2 ** (attempt - 1);
      console.warn(
        `notarize+staple attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs / 1000}s\n${String(err)}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// When a real Developer ID cert is provided (CSC_LINK set), electron-builder does
// proper signing and we notarize ourselves (notarizeWithRetryMac); the ad-hoc
// fallback must be skipped — they conflict. Without a cert (CI dispatch, forks) we
// fall back to ad-hoc signing so the bundle at least launches on Apple Silicon.
const hasDeveloperIdCert = Boolean(process.env.CSC_LINK);

// Azure Artifact Signing credentials reach the build as an OIDC login performed
// by the release workflow, which only happens on main and tags. Elsewhere — a
// branch dispatch, a fork, a local build — there is nothing to sign with, so the
// `win.azureSignOptions` key below must be absent rather than merely unusable:
// electron-builder picks its signing backend from that key's presence alone and
// never checks for credentials, so leaving it set would send every build down
// the Azure path, which shells out to PowerShell and fails without them.
// Omitting it selects the signtool backend, which finds no certificate and skips
// signing rather than failing. Unsigned Windows builds warn via SmartScreen but
// install (CHOO-1468).
const hasAzureSigning = Boolean(process.env.AZURE_CLIENT_ID);

const LOCAL_SERVER_DIR = resolve('dist-local-server');
const LOCAL_SERVER_RESOURCE = 'local-server';
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function isMachO(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGICS.has(head.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

// Paths (relative to the bundle, following symlinks as @electron/osx-sign does)
// of every Mach-O in the local-server bundle.
function localServerMachOs(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && isMachO(path)) found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found;
}

// @electron/osx-sign codesigns every file it considers binary, which in the
// local-server bundle means hundreds of data files (PostgreSQL's timezone
// tables, fonts, wheels) on top of its few dozen executables and libraries.
// Each signature makes a round trip to Apple's timestamp server, and a single
// dropped one fails the whole build. Only Mach-O needs a signature for
// notarization, so everything else under the resource is left out of signing
// (it is still sealed by the app's own signature). The exceptions are found by
// file magic, not by path, so a binary added to the bundle later is signed
// without anyone updating a list. Without a bundle on disk nothing is skipped.
function localServerSignIgnore(): string[] {
  if (!existsSync(LOCAL_SERVER_DIR)) return [];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keep = localServerMachOs(LOCAL_SERVER_DIR).map(escape).join('|');
  const prefix = escape(`/Contents/Resources/${LOCAL_SERVER_RESOURCE}/`);
  return [keep ? `${prefix}(?!(?:${keep})$)` : prefix];
}

const config: Configuration = {
  // Must run AFTER electron-builder applies @electron/fuses (which rewrites the
  // Electron Framework binary and would invalidate an earlier signature). afterSign
  // fires after the fuse + (skipped) signing phase, so it's the correct hook.
  afterSign: hasDeveloperIdCert ? notarizeWithRetryMac : adhocSignMac,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  // Electron reads `desktopName` from the packaged package.json and uses it as the
  // Linux app_id / WM_CLASS. Paired with linux.syncDesktopName, the installed
  // .desktop entry gets the same basename, so desktop environments can associate a
  // running window with its launcher (pinning, one dock entry, correct icon).
  extraMetadata: {
    desktopName: `${APP_NAME_LOWER}.desktop`,
  },
  // Claim the switchdash:// URL scheme so the OS routes deeplinks (from Slack /
  // Mattermost messages) to this app. On macOS this writes CFBundleURLTypes
  // into Info.plist — the canonical registration; the runtime
  // setAsDefaultProtocolClient call only suffices for the un-packaged dev app.
  protocols: [
    {
      name: 'Switch Console deeplink',
      schemes: ['switchdash'],
    },
  ],
  directories: { output: 'release' },
  artifactName: `${ARTIFACT_PREFIX}-\${arch}.\${ext}`,
  // Switch Console is distributed via GitHub Releases on the switch repo. This is
  // the one place the release identity diverges from Switch Console (the app id /
  // artifact names stay on Switch Console — see AGENTS.md).
  publish: [
    {
      provider: 'github',
      owner: RELEASE_REPO_OWNER,
      repo: RELEASE_REPO_NAME,
      releaseType: 'release',
    },
  ],
  generateUpdatesFilesForAllChannels: false,
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
  // The remote runtime sidecar (CHOO-1059) is a pure-Node bundle SFTP'd to the
  // agent's VM, not loaded into the Electron process — ship it as an unpacked
  // resource so resolveSidecarBundlePath() finds it under process.resourcesPath.
  // The agent controller bundle (agent-controller.mjs) ships beside it the same
  // way, so the child Console runs it in (its own binary with
  // ELECTRON_RUN_AS_NODE) reads it from a plain path, as the shared host is.
  //
  // The native local server's toolchain (PostgreSQL, uv, Python and switch-core
  // with its wheels) ships the same way, built for the host platform by
  // `pnpm run build:local-server`, so setting up a local server downloads
  // nothing. Its executables are signed with the app: on macOS every Mach-O in
  // the bundle, on Windows every `.exe` among the extra resources (electron-
  // builder's default for them). Console copies them out of the app before
  // running them, so a running server never holds the app's own files.
  extraResources: [
    { from: 'dist-sidecar', to: 'dist-sidecar' },
    { from: 'dist-local-server', to: LOCAL_SERVER_RESOURCE },
  ],
  asarUnpack: ['node_modules/better-sqlite3/**', 'node_modules/@parcel/watcher/**', '**/*.node'],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    signIgnore: localServerSignIgnore(),
    // No `arch` here, for the same reason as `linux` below: naming an arch makes
    // every invocation build it and ignore the `--x64` / `--arm64` flag, and
    // `npmRebuild: false` means the package carries whatever native modules the
    // earlier `pnpm rebuild` produced for the host. The release workflow builds
    // each arch on a runner of that arch and passes the matching flag.
    target: ['dmg', 'zip'],
    icon: 'src/assets/images/switch-console/switch-console-beta.icns',
    // Notarization is done by notarizeWithRetryMac in `afterSign` (with retry),
    // not by electron-builder, so its built-in step stays off. The App Store
    // Connect API key is read there from APPLE_API_KEY (path to .p8) /
    // APPLE_API_KEY_ID / APPLE_API_ISSUER.
    notarize: false,
  },
  dmg: {
    icon: 'src/assets/images/switch-console/switch-console-beta.icns',
    window: { width: 530, height: 319 },
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 398, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    category: 'Development',
    // fpm requires a maintainer for the .deb and .rpm targets; without it the
    // packaging step aborts before writing any Linux artifact.
    maintainer: 'Louis Amaudruz <louis.amaudruz@sandboxaq.com>',
    // Overrides the top-level `executableName: PRODUCT_NAME`, which contains a
    // space. A space in the Linux binary name has to be quoted in the .desktop
    // Exec line and in the deb/rpm install path; keeping the lowercase,
    // space-free name avoids that and matches `desktopName` above.
    executableName: APP_NAME_LOWER,
    syncDesktopName: true,
    // No `arch` here on purpose: electron-builder then builds the HOST arch,
    // or whichever `--x64` / `--arm64` the caller passes. Naming both arches
    // in the target entries instead makes every invocation build both and
    // ignore the flag — which is not merely slow. `npmRebuild: false` means
    // the native modules (better-sqlite3, @parcel/watcher) are
    // whatever the earlier `pnpm rebuild` produced for the host, copied into
    // every package unchanged, so the non-host arch comes out installable,
    // launchable, and dead on the first require of a wrong-arch `.node`. The
    // release workflow builds each arch on a runner of that arch.
    target: ['AppImage', 'deb', 'rpm'],
  },
  // deb/rpm package names must be lowercase and space-free, so they are pinned
  // rather than derived from the display name (same as the canary channel).
  deb: {
    packageName: APP_NAME_LOWER,
  },
  rpm: {
    packageName: APP_NAME_LOWER,
  },
  win: {
    icon: 'src/assets/images/switch-console/app-icon-beta.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'msi', arch: ['x64'] },
    ],
    // Copies `publisherName` below into app-update.yml, so electron-updater
    // refuses any downloaded update whose Authenticode subject does not match
    // it. Only meaningful on a signed build: an unsigned one has no
    // azureSignOptions, electron-builder then has no publisher to write, and
    // the manifest simply carries no name for the updater to check.
    verifyUpdateCodeSignature: true,
    ...(hasAzureSigning
      ? {
          azureSignOptions: {
            endpoint: 'https://eus.codesigning.azure.net/',
            codeSigningAccountName: 'cg-asa-basic-eastus',
            certificateProfileName: 'cg-public',
            // The certificate's subject, verbatim, as read off a signed
            // installer produced by this config. electron-builder strips this
            // before the signing call — it never reaches the certificate — so
            // its sole effect is the name written into app-update.yml. Given
            // as a full distinguished name rather than the bare CN because
            // electron-updater compares every component it is given and warns
            // when handed a CN alone. It must be updated in step with the
            // certificate: a stale name here breaks updates for every existing
            // install, silently and only at update time.
            publisherName: 'CN=SandboxAQ, O=SandboxAQ, L=Tarrytown, S=New York, C=US',
          },
        }
      : {}),
  },
  msi: {
    oneClick: false,
    perMachine: false,
  },
  nsis: {
    differentialPackage: true,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  npmRebuild: false,
  // Encrypt Chromium's on-disk cookie store (in-app browser logins) with OS-level
  // keys, like Chrome does. One-way: never disable once shipped or existing
  // cookie stores become unreadable.
  electronFuses: {
    enableCookieEncryption: true,
  },
};

export default config;
