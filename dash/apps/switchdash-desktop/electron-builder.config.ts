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
      name: 'switchdash deeplink',
      schemes: ['switchdash'],
    },
  ],
  directories: { output: 'release' },
  artifactName: `${ARTIFACT_PREFIX}-\${arch}.\${ext}`,
  // switchdash is distributed via GitHub Releases on the private switch repo.
  // The app reads the auth-gated feed using the user's `gh` CLI token (see
  // src/main/core/updates). This is the one place the release identity diverges
  // from switchdash (the app id / artifact names stay on switchdash — see AGENTS.md).
  publish: [
    {
      provider: 'github',
      owner: RELEASE_REPO_OWNER,
      repo: RELEASE_REPO_NAME,
      private: true,
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
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    icon: 'src/assets/images/switchdash/switchdash-beta.icns',
    // electron-builder reads the App Store Connect API key from APPLE_API_KEY
    // (path to .p8) / APPLE_API_KEY_ID / APPLE_API_ISSUER when notarize is on.
    notarize: hasDeveloperIdCert,
  },
  dmg: {
    icon: 'src/assets/images/switchdash/switchdash-beta.icns',
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
    syncDesktopName: true,
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
  },
  win: {
    icon: 'src/assets/images/switchdash/app-icon-beta.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'msi', arch: ['x64'] },
    ],
    azureSignOptions: {
      publisherName: 'General Action, Inc.',
      endpoint: 'https://eus.codesigning.azure.net/',
      certificateProfileName: 'switchdash-public',
      codeSigningAccountName: 'switchdash',
    },
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
