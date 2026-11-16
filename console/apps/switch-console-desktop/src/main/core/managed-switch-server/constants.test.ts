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
    expect(stackProjectName('My Data.Dir', 'local')).toMatch(/^my-data-dir-[0-9a-f]{8}-local$/);
    expect(stackProjectName('.hidden', 'remote')).toMatch(/^hidden-[0-9a-f]{8}-remote$/);
    expect(stackProjectName('...', 'local')).toMatch(/^switchdash-[0-9a-f]{8}-local$/);
  });

  it('keeps data folders apart whose names differ only in punctuation or case', () => {
    expect(stackProjectName('x-y', 'local')).toBe('x-y-local');
    expect(stackProjectName('x.y', 'local')).not.toBe(stackProjectName('x-y', 'local'));
    expect(stackProjectName('x.y', 'local')).toMatch(/^x-y-[0-9a-f]{8}-local$/);
    expect(stackProjectName('team.alpha', 'remote')).not.toBe(
      stackProjectName('team-alpha', 'remote')
    );
    expect(stackProjectName('Team-Alpha', 'local')).not.toBe(
      stackProjectName('team-alpha', 'local')
    );
    // The same folder always gets the same name.
    expect(stackProjectName('x.y', 'local')).toBe(stackProjectName('x.y', 'local'));
    // Nor can a punctuated name land on the stable app's own stack.
    expect(stackProjectName('.switchdash', 'local')).not.toBe('switchdash-local');
  });
});
