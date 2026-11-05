import { describe, expect, it } from 'vitest';
import { workspaceNavViews } from './workspace-nav-views';

describe('Your cloud files in the nav', () => {
  it('follows Connectors when it shows', () => {
    expect(
      workspaceNavViews({
        managed: false,
        serviceConnections: true,
        administers: false,
        cloudFiles: true,
      })
    ).toEqual(['server', 'serverAgents', 'serverRooms', 'connectors', 'cloudFiles', 'templates']);
  });

  it('follows Your Rooms where there are no connectors', () => {
    expect(
      workspaceNavViews({
        managed: false,
        serviceConnections: false,
        administers: false,
        cloudFiles: true,
      })
    ).toEqual(['server', 'serverAgents', 'serverRooms', 'cloudFiles', 'templates']);
  });

  it('is left out while it is hidden, or not said', () => {
    for (const cloudFiles of [false, undefined])
      expect(
        workspaceNavViews({
          managed: false,
          serviceConnections: true,
          administers: false,
          cloudFiles,
        })
      ).not.toContain('cloudFiles');
  });
});
