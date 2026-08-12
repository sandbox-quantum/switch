import type { Configuration } from 'electron-builder';
import {
  APP_ID,
  APP_NAME_LOWER,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
} from './src/shared/app-identity.canary.ts';

const config: Configuration = {
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  // Canary-specific desktop entry name so it never collides with the stable
  // channel's (see the base config for what desktopName does).
  extraMetadata: {
    desktopName: `${APP_NAME_LOWER}.desktop`,
  },
  // Claim the switchdash:// scheme so the OS routes deeplinks to the app (see
  // the base config for details).
  protocols: [
    {
      name: 'Switch Console deeplink',
      schemes: ['switchdash'],
    },
  ],
  directories: { output: 'release' },
  artifactName: `${ARTIFACT_PREFIX}-\${arch}.\${ext}`,
  publish: [
    {
      provider: 'github',
      owner: RELEASE_REPO_OWNER,
      repo: RELEASE_REPO_NAME,
      releaseType: 'draft',
      // 'canary' must match the prerelease identifier in scripts/release/lib/version.ts
      // (e.g. 1.1.33-canary.42 -> prerelease id "canary"). electron-updater uses this
      // id to select the matching release from the Atom feed and to construct the
      // channel filename (canary*.yml) it fetches from GitHub.
      channel: 'canary',
    },
  ],
  generateUpdatesFilesForAllChannels: false,
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
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
    icon: 'src/assets/images/switch-console/switch-console-canary.icns',
    notarize: false,
  },
  dmg: {
    icon: 'src/assets/images/switch-console/switch-console-canary.icns',
    window: { width: 530, height: 319 },
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 398, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    category: 'Development',
    executableName: APP_NAME_LOWER,
    // Same fpm requirement as the stable channel — deb/rpm cannot package
    // without it.
    maintainer: 'Louis Amaudruz <louis.amaudruz@sandboxaq.com>',
    syncDesktopName: true,
    // Arch comes from the CLI flag / host — see the base config for why naming
    // both arches here produces a broken package.
    target: ['AppImage', 'deb', 'rpm'],
  },
  deb: {
    packageName: APP_NAME_LOWER,
  },
  rpm: {
    packageName: APP_NAME_LOWER,
  },
  // Unsigned, like the base config — see the `win` comment there before adding
  // any signing key here.
  win: {
    icon: 'src/assets/images/switch-console/app-icon-canary.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'msi', arch: ['x64'] },
    ],
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
