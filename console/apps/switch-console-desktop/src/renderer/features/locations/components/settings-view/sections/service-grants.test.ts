import { describe, expect, it } from 'vitest';
import { grantedRepositoryIds, grantedRepositoryNames, onOffGrantBlock } from './service-grants';

const GITHUB = {
  status: 'connected' as const,
  login: 'ada-gh',
  install_url: 'https://github.com/apps/example/installations/new',
  installations: [
    { id: 7, account: 'example-org', repositories: [{ id: 70, name: 'example-org/project' }] },
  ],
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

describe('turning an on/off grant on', () => {
  const service = {
    name: 'Example',
    status: 'connected' as const,
    unavailable_reason: null,
    workspace_enabled: true,
  };

  it('is allowed for a connected service the workspace has on, or with no workspace switch', () => {
    expect(onOffGrantBlock(service, false)).toBeNull();
    expect(onOffGrantBlock({ ...service, workspace_enabled: null }, false)).toBeNull();
  });

  it('is blocked with the workspace reason while the workspace has it off', () => {
    expect(onOffGrantBlock({ ...service, workspace_enabled: false }, false)).toEqual({
      reason:
        'Example is not enabled in this workspace. Ask a workspace admin; they switch it on under Connectors.',
      blocksOn: true,
    });
  });

  it('still lets a grant be turned off, saying why it does nothing now', () => {
    expect(onOffGrantBlock({ ...service, workspace_enabled: false }, true)).toMatchObject({
      blocksOn: false,
    });
  });

  it("puts the server's reason before the workspace's", () => {
    expect(
      onOffGrantBlock(
        { ...service, unavailable_reason: 'Maintenance', workspace_enabled: false },
        false
      )
    ).toEqual({ reason: 'Maintenance', blocksOn: true });
  });

  it('sends a service nobody connected to Connectors', () => {
    expect(onOffGrantBlock({ ...service, status: 'not_connected' }, false)).toEqual({
      reason: 'To turn Example on, first connect it from Connectors.',
      blocksOn: true,
    });
  });
});
