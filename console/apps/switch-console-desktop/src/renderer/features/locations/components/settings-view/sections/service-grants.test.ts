import { describe, expect, it } from 'vitest';
import { grantedRepositoryIds, grantedRepositoryNames } from './service-grants';

const GITHUB = {
  status: 'connected' as const,
  login: 'ada-gh',
  install_url: 'https://github.com/apps/example/installations/new',
  installations: [{ id: 7, account: 'example-org', repositories: [{ id: 70, name: 'project' }] }],
};

describe('GitHub grant helpers', () => {
  it('names the granted repositories, by id once they are out of sight', () => {
    const resources = { installation_id: 7, repository_ids: [70, 71] };
    expect(grantedRepositoryNames(GITHUB, resources)).toEqual([
      'example-org/project',
      'repository 71',
    ]);
    expect(grantedRepositoryNames(undefined, resources)).toEqual([
      'repository 70',
      'repository 71',
    ]);
  });

  it('reads only numeric repository ids', () => {
    expect(grantedRepositoryIds({ repository_ids: [1, 'two', 3] })).toEqual([1, 3]);
    expect(grantedRepositoryIds({})).toEqual([]);
  });
});
