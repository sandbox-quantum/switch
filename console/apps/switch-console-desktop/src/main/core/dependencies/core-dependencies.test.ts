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

  it('has no Windows option for tmux, which does not run there', () => {
    expect(pickInstallOption(descriptor('tmux'), 'windows')).toBeUndefined();
  });
});
