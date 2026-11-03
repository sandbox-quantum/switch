// The tester's build's identity, for electron-builder.test.config.ts, which loads
// it under Node, where extensionless ESM specifiers do not resolve: inlined, with no
// imports, like app-identity.canary.ts. Mirrors the `isTest` values in
// ./app-identity.ts (a test checks they match).
export const APP_ID = 'com.switchdash.test';
export const PRODUCT_NAME = 'Switch Console Test';
export const APP_NAME_LOWER = 'switch-console-test';
export const ARTIFACT_PREFIX = 'switch-console-test';
