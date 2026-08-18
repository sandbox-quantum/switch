import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkoutBuildOverrideYaml,
  findCoreCheckout,
  isCheckoutBuildEnabled,
  setCheckoutBuildEnabled,
} from './checkout-build';

async function fakeCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'switch-checkout-'));
  for (const marker of [
    'core/pyproject.toml',
    'deploy/shared_resources/images/Dockerfile.switch',
    'deploy/shared_resources/images/Dockerfile.gateway',
    'deploy/shared_resources/images/Dockerfile.setup',
  ]) {
    const path = join(root, marker);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
  }
  return root;
}

describe('findCoreCheckout', () => {
  it('finds the checkout root from a directory inside it', async () => {
    const root = await fakeCheckout();
    const nested = join(root, 'console', 'apps', 'switch-console-desktop');
    await mkdir(nested, { recursive: true });

    expect(findCoreCheckout(nested)).toBe(root);
  });

  /** A packaged install is not in a source tree, and half a tree cannot be
   * built — offering the option there would fail at `docker build`. */
  it('answers null when no ancestor carries all the build inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'not-switch-'));
    await mkdir(join(root, 'core'), { recursive: true });
    await writeFile(join(root, 'core', 'pyproject.toml'), '');

    expect(findCoreCheckout(root)).toBeNull();
  });
});

describe('checkoutBuildOverrideYaml', () => {
  /** The override is written into the stack's working dir under user-data, so a
   * relative context would resolve there rather than in the checkout. */
  it('gives every built service an absolute context in the checkout', () => {
    const yaml = checkoutBuildOverrideYaml('/src/switch');

    for (const service of ['switch', 'gateway', 'setup']) {
      expect(yaml).toContain(`  ${service}:`);
    }
    expect(yaml).toContain('context: "/src/switch"');
    expect(yaml).not.toContain('context: .');
    expect(yaml).toContain('dockerfile: deploy/shared_resources/images/Dockerfile.switch');
  });

  it('quotes a path with spaces so compose reads one value', () => {
    expect(checkoutBuildOverrideYaml('/Users/dev/my switch')).toContain(
      'context: "/Users/dev/my switch"'
    );
  });
});

describe('the persisted choice', () => {
  it('round-trips, and is off until it has been turned on', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'switch-state-'));
    const host = { stateDir };

    expect(await isCheckoutBuildEnabled(host)).toBe(false);

    await setCheckoutBuildEnabled(host, true);
    expect(await isCheckoutBuildEnabled(host)).toBe(true);

    await setCheckoutBuildEnabled(host, false);
    expect(await isCheckoutBuildEnabled(host)).toBe(false);
  });
});
