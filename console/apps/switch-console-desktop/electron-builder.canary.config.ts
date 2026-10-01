import type { Configuration } from 'electron-builder';
import stable from './electron-builder.config.ts';
import {
  APP_ID,
  APP_NAME_LOWER,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
} from './src/shared/app-identity.canary.ts';

// Canary is the stable build with a different identity, icon and update channel.
// Everything else — bundled resources, signing, notarization, per-arch targets —
// is inherited, so a packaging change made to the stable config reaches canary
// without anyone having to remember it. Override only what must differ.
const config: Configuration = {
  ...stable,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  extraMetadata: {
    ...stable.extraMetadata,
    desktopName: `${APP_NAME_LOWER}.desktop`,
  },
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
  mac: {
    ...stable.mac,
    icon: 'src/assets/images/switch-console/switch-console-canary.icns',
  },
  dmg: {
    ...stable.dmg,
    icon: 'src/assets/images/switch-console/switch-console-canary.icns',
  },
  linux: {
    ...stable.linux,
    executableName: APP_NAME_LOWER,
  },
  deb: {
    ...stable.deb,
    packageName: APP_NAME_LOWER,
  },
  rpm: {
    ...stable.rpm,
    packageName: APP_NAME_LOWER,
  },
  win: {
    ...stable.win,
    icon: 'src/assets/images/switch-console/app-icon-canary.png',
  },
};

export default config;
