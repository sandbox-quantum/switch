import { readFileSync } from 'node:fs';
import { pickInstallOption } from '@switch-console/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { CORE_DEPENDENCIES } from './core-dependencies';

function descriptor(id: string) {
  const found = CORE_DEPENDENCIES.find((d) => d.id === id);
  if (!found) throw new Error(`no core dependency ${id}`);
  return found;
}

describe('CORE_DEPENDENCIES on Windows', () => {
  it.each([
    ['git', 'winget install --id Git.Git'],
    ['node', 'winget install --id OpenJS.NodeJS.LTS'],
  ])('offers a winget install for %s', (id, command) => {
    expect(pickInstallOption(descriptor(id), 'windows')?.command).toBe(command);
  });
});

/** The `>=x.y` floor a console package declares for Node, as [major, minor]. */
function nodeFloor(pkg: string): [number, number] {
  const url = new URL(`../../../../../../packages/${pkg}/package.json`, import.meta.url);
  const engines = (JSON.parse(readFileSync(url, 'utf8')) as { engines: { node: string } }).engines;
  const [major, minor = '0'] = engines.node.replace('>=', '').split('.');
  return [Number(major), Number(minor)];
}

describe('the Node a remote host needs', () => {
  it('is at least what the agent runtime and the agents controller run on', () => {
    const [major, minor] = (descriptor('node').minVersion ?? '').split('.').map(Number);
    for (const pkg of ['switch-agent-runtime', 'agent-controller']) {
      const [needMajor, needMinor] = nodeFloor(pkg);
      expect(major > needMajor || (major === needMajor && minor >= needMinor), pkg).toBe(true);
    }
  });

  it('upgrades a Homebrew Node that is already there rather than leaving it', () => {
    expect(pickInstallOption(descriptor('node'), 'macos')?.command).toBe(
      'brew upgrade node 2>/dev/null || brew install node'
    );
  });
});
