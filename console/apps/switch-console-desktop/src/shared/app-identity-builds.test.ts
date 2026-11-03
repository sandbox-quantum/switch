import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type * as AppIdentity from './app-identity';
import * as testbuild from './app-identity.testbuild';

type Identity = typeof AppIdentity;

/**
 * app-identity.ts as a packaged build of `build` (VITE_BUILD) sees it. The module
 * reads `import.meta.env` once, at load, through a cast the test runner doesn't
 * rewrite, so its real source is compiled and run here with that build's env.
 */
function identityOf(build: string): Identity {
  const source = readFileSync(join(import.meta.dirname, 'app-identity.ts'), 'utf8');
  const reading = '(import.meta as ImportMetaWithEnv).env';
  expect(source.split(reading)).toHaveLength(2);
  const { outputText } = ts.transpileModule(source.replace(reading, '__env'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} as Identity };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    __env: { DEV: false, VITE_BUILD: build },
  });
  return module.exports;
}

describe('the build identities', () => {
  it('keeps stable exactly as it was', () => {
    const id = identityOf('');
    expect([
      id.APP_ID,
      id.PRODUCT_NAME,
      id.OS_APP_NAME,
      id.APP_NAME_LOWER,
      id.USER_DATA_DIR_NAME,
      id.UPDATE_CHANNEL,
      id.ARTIFACT_PREFIX,
      id.IS_CANARY,
      id.IS_TEST_BUILD,
    ]).toEqual([
      'com.switchdash.stable',
      'Switch Console',
      'Switchdash',
      'switch-console',
      'switchdash',
      'v1-stable',
      'switch-console',
      false,
      false,
    ]);
  });

  it('keeps canary exactly as it was, sharing stable data on purpose', () => {
    const id = identityOf('canary');
    expect([
      id.APP_ID,
      id.PRODUCT_NAME,
      id.OS_APP_NAME,
      id.APP_NAME_LOWER,
      id.USER_DATA_DIR_NAME,
      id.UPDATE_CHANNEL,
      id.ARTIFACT_PREFIX,
      id.IS_CANARY,
      id.IS_TEST_BUILD,
    ]).toEqual([
      'com.switchdash.canary',
      'Switch Console Canary',
      'Switchdash',
      'switch-console-canary',
      'switchdash',
      'v1-canary',
      'switch-console-canary',
      true,
      false,
    ]);
  });

  it('gives the test build its own install, data folder and keychain name', () => {
    const id = identityOf('test');
    expect([
      id.APP_ID,
      id.PRODUCT_NAME,
      id.OS_APP_NAME,
      id.APP_NAME_LOWER,
      id.USER_DATA_DIR_NAME,
      id.ARTIFACT_PREFIX,
      id.IS_CANARY,
      id.IS_TEST_BUILD,
    ]).toEqual([
      'com.switchdash.test',
      'Switch Console Test',
      'Switchdash Test',
      'switch-console-test',
      'switchdash-test',
      'switch-console-test',
      false,
      true,
    ]);
    // electron-builder.test.config.ts reads the inlined copy; it must say the same.
    expect([
      testbuild.APP_ID,
      testbuild.PRODUCT_NAME,
      testbuild.APP_NAME_LOWER,
      testbuild.ARTIFACT_PREFIX,
    ]).toEqual([id.APP_ID, id.PRODUCT_NAME, id.APP_NAME_LOWER, id.ARTIFACT_PREFIX]);
  });
});
