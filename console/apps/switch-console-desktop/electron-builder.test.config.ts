import type { Configuration } from 'electron-builder';
import stable from './electron-builder.config.ts';
import {
  APP_ID,
  APP_NAME_LOWER,
  ARTIFACT_PREFIX,
  PRODUCT_NAME,
} from './src/shared/app-identity.testbuild.ts';

// A build for testers: the stable build with its own identity, so it installs beside
// Switch Console and Switch Console Canary without replacing either, and keeps its own
// data (`switchdash-test`) and keychain name (set at run time from app-identity.ts with
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
  artifactName: `${ARTIFACT_PREFIX}-\${arch}.\${ext}`,
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
