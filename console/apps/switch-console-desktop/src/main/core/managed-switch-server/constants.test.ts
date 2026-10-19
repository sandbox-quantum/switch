import { describe, expect, it } from 'vitest';
import { stackProjectName } from './constants';

describe('stackProjectName', () => {
  it('keeps the names existing installs are attached to', () => {
    expect(stackProjectName('switchdash', 'local')).toBe('switchdash-local');
    expect(stackProjectName('switchdash', 'remote')).toBe('switchdash-remote');
    expect(stackProjectName('switchdash-dev', 'local')).toBe('switchdash-dev-local');
  });

  it('gives each data directory a stack of its own', () => {
    expect(stackProjectName('switchdash-fresh-20261016-144027', 'local')).toBe(
      'switchdash-fresh-20261016-144027-local'
    );
    expect(stackProjectName('switchdash-local-cloud', 'local')).not.toBe(
      stackProjectName('switchdash-dev', 'local')
    );
  });

  it('only uses what compose accepts in a project name', () => {
    expect(stackProjectName('My Data.Dir', 'local')).toBe('my-data-dir-local');
    expect(stackProjectName('.hidden', 'remote')).toBe('hidden-remote');
    expect(stackProjectName('...', 'local')).toBe('switchdash-local');
  });
});
