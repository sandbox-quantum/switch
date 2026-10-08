import { describe, expect, it } from 'vitest';
import type { ConnectionGrant } from '@shared/core/switch-servers/connection-grants';
import { connectionGrantsProblem, gitHubAccess, withGitHubAccess } from './connection-grants';

const GRANTS: ConnectionGrant[] = [
  {
    slug: 'github',
    installations: [
      { installation_id: 123, repositories: 'all' },
      { installation_id: 456, repositories: [111, 222] },
    ],
  },
];

describe('gitHubAccess', () => {
  it('reads all, selected, and no access per installation', () => {
    expect(gitHubAccess(GRANTS, 123)).toEqual({ kind: 'all' });
    expect(gitHubAccess(GRANTS, 456)).toEqual({ kind: 'selected', repositories: [111, 222] });
    expect(gitHubAccess(GRANTS, 789)).toEqual({ kind: 'none' });
    expect(gitHubAccess([], 123)).toEqual({ kind: 'none' });
  });
});

describe('withGitHubAccess', () => {
  it('adds the GitHub grant for the first installation given access', () => {
    expect(withGitHubAccess([], 123, { kind: 'all' })).toEqual([
      { slug: 'github', installations: [{ installation_id: 123, repositories: 'all' }] },
    ]);
  });

  it('replaces an installation in place and appends a new one', () => {
    const changed = withGitHubAccess(GRANTS, 123, { kind: 'selected', repositories: [9] });
    expect(changed[0].installations).toEqual([
      { installation_id: 123, repositories: [9] },
      { installation_id: 456, repositories: [111, 222] },
    ]);
    expect(withGitHubAccess(GRANTS, 789, { kind: 'all' })[0].installations).toHaveLength(3);
  });

  it('drops an installation given no access, and the grant once none is left', () => {
    const one = withGitHubAccess(GRANTS, 123, { kind: 'none' });
    expect(one).toEqual([
      { slug: 'github', installations: [{ installation_id: 456, repositories: [111, 222] }] },
    ]);
    expect(withGitHubAccess(one, 456, { kind: 'none' })).toEqual([]);
  });

  it('leaves the other connections alone', () => {
    const linear = { slug: 'linear', installations: [] };
    expect(withGitHubAccess([linear], 1, { kind: 'all' })).toEqual([
      linear,
      { slug: 'github', installations: [{ installation_id: 1, repositories: 'all' }] },
    ]);
  });
});

describe('connectionGrantsProblem', () => {
  const account = (id: number) => (id === 456 ? 'acme' : null);

  it('accepts all and non-empty selections', () => {
    expect(connectionGrantsProblem(GRANTS, account)).toBeNull();
    expect(connectionGrantsProblem([], account)).toBeNull();
  });

  it('names the account whose selection is empty', () => {
    const empty = withGitHubAccess(GRANTS, 456, { kind: 'selected', repositories: [] });
    expect(connectionGrantsProblem(empty, account)).toMatch(/at least one repository for acme/);
  });

  it('refuses more repositories than GitHub scopes a token to', () => {
    const many = withGitHubAccess([], 7, {
      kind: 'selected',
      repositories: Array.from({ length: 501 }, (_, i) => i + 1),
    });
    expect(connectionGrantsProblem(many, account)).toMatch(/at most 500 repositories/);
  });
});
