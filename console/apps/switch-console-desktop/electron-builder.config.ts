import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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

// When a real Developer ID cert is provided (CSC_LINK set), electron-builder does
// proper signing + notarization and the ad-hoc fallback must be skipped — they
// conflict. Without a cert (CI dispatch, forks) we fall back to ad-hoc signing so
// the bundle at least launches on Apple Silicon.
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

const config: Configuration = {
  // Must run AFTER electron-builder applies @electron/fuses (which rewrites the
  // Electron Framework binary and would invalidate an earlier signature). afterSign
  // fires after the fuse + (skipped) signing phase, so it's the correct hook.
  afterSign: hasDeveloperIdCert ? undefined : adhocSignMac,
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
  extraResources: [{ from: 'dist-sidecar', to: 'dist-sidecar' }],
  asarUnpack: [
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    'node_modules/@parcel/watcher/**',
    '**/*.node',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // No `arch` here, for the same reason as `linux` below: naming an arch makes
    // every invocation build it and ignore the `--x64` / `--arm64` flag, and
    // `npmRebuild: false` means the package carries whatever native modules the
    // earlier `pnpm rebuild` produced for the host. The release workflow builds
    // each arch on a runner of that arch and passes the matching flag.
    target: ['dmg', 'zip'],
    icon: 'src/assets/images/switch-console/switch-console-beta.icns',
    // electron-builder reads the App Store Connect API key from APPLE_API_KEY
    // (path to .p8) / APPLE_API_KEY_ID / APPLE_API_ISSUER when notarize is on.
    notarize: hasDeveloperIdCert,
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
    // the native modules (better-sqlite3, node-pty, @parcel/watcher) are
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
    // Off until the certificate's subject common name is known verbatim. This
    // flag is what decides whether `publisherName` below is copied into
    // app-update.yml, and electron-updater rejects any update whose signature
    // does not match the name it finds there. A wrong name therefore breaks
    // updating for everyone already installed, and does so silently and later —
    // whereas leaving the field out of the manifest merely skips the check.
    // Turn this on in the same change that sets the real name.
    verifyUpdateCodeSignature: false,
    ...(hasAzureSigning
      ? {
          azureSignOptions: {
            endpoint: 'https://eus.codesigning.azure.net/',
            codeSigningAccountName: 'cg-asa-basic-eastus',
            certificateProfileName: 'cg-public',
            // Required by electron-builder's schema, so it cannot be omitted, but
            // it is stripped before the signing call and never reaches the
            // certificate — the signature's real publisher comes from the
            // certificate itself. Its only effect is on app-update.yml, which
            // verifyUpdateCodeSignature: false above suppresses. Treat it as
            // unverified until a signed build confirms the actual subject.
            publisherName: 'SandboxAQ',
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
