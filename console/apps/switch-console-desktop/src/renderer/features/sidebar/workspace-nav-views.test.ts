import { describe, expect, it } from 'vitest';
import { workspaceNavViews } from './workspace-nav-views';

describe('Your cloud files in the nav', () => {
  it('follows Rooms when it shows', () => {
    expect(workspaceNavViews({ serviceConnections: true, admin: false, cloudFiles: true })).toEqual(
      ['server', 'serverAgents', 'serverRooms', 'cloudFiles', 'library', 'templates', 'connectors']
    );
  });

  it('is in the same place where there are no connectors', () => {
    expect(workspaceNavViews({ serviceConnections: false, admin: true, cloudFiles: true })).toEqual(
      ['server', 'serverAgents', 'serverRooms', 'cloudFiles', 'library', 'templates', 'admin']
    );
  });

  it("is left out while it is hidden, or not said, so the nav is main's", () => {
    for (const cloudFiles of [false, undefined])
      expect(workspaceNavViews({ serviceConnections: true, admin: true, cloudFiles })).toEqual([
        'server',
        'serverAgents',
        'serverRooms',
        'library',
        'templates',
        'connectors',
        'admin',
      ]);
  });
});
