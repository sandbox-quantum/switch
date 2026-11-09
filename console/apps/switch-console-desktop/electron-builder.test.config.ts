import type { Configuration } from 'electron-builder';
import stable from './electron-builder.config.ts';
import {
  APP_ID,
  APP_NAME_LOWER,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
} from './src/shared/app-identity.testbuild.ts';

// A test build's label (VITE_BUILD_LABEL, for example "0.0.6") goes into the
// download's name, by the same rule as app-identity.ts's ARTIFACT_NAME_PREFIX:
// plain characters only, at most 40, lower-cased with runs of other characters
// turned into "-". Inlined because this file loads under bare Node.
const rawLabel = (process.env.VITE_BUILD_LABEL ?? '').trim();
const label = rawLabel.length <= 40 && /^[A-Za-z0-9 .·()_-]*$/.test(rawLabel) ? rawLabel : '';
const labelSlug = label
  .toLowerCase()
  .replace(/[^a-z0-9.]+/g, '-')
  .replace(/^-+|-+$/g, '');
const artifactNamePrefix = labelSlug ? `${ARTIFACT_PREFIX}-${labelSlug}` : ARTIFACT_PREFIX;

// A build for testers: the stable build with its own identity, so it installs beside
// Switch Console and Switch Console Canary without replacing either, and keeps its own
// data (`switchdash-hosted-v2`) and keychain name (set at run time from app-identity.ts with
// VITE_BUILD=test). It publishes nothing and checks for no updates. Packaged on a Mac
// without a Developer ID it gets the stable config's ad-hoc signature: it launches, and
// macOS asks once (right-click, then Open).
const config: Configuration = {
  ...stable,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  extraMetadata: {
    ...stable.extraMetadata,
    desktopName: `${APP_NAME_LOWER}.desktop`,
  },
  artifactName: `${artifactNamePrefix}-\${arch}.\${ext}`,
  // No switchdash:// claim: links from Slack and Mattermost keep opening the
  // everyday Console (src/main/app/deeplinks.ts skips the run-time claim too).
  protocols: [],
  directories: { output: 'release/test' },
  publish: null,
  mac: {
    ...stable.mac,
    notarize: false,
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
};

export default config;
