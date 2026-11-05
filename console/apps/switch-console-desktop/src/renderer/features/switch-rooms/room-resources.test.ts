import { describe, expect, it } from 'vitest';
import type { RoomResource } from '@shared/core/switch-servers/switch-servers';
import { attachableResources, resourcesByOrigin } from './room-resources';

const resource = (overrides: Partial<RoomResource>): RoomResource => ({
  id: 'r',
  kind: 'documents',
  name: 'Doc',
  description: '',
  typeLabel: null,
  urls: [],
  roomScoped: false,
  createdByAgentName: null,
  packageIds: [],
  ...overrides,
});

describe('a room’s resources', () => {
  it('keeps the documents agents wrote here apart from the library’s', () => {
    const { library, roomScoped } = resourcesByOrigin([
      resource({ id: 'lib' }),
      resource({ id: 'mine', roomScoped: true }),
    ]);
    expect(library.map((r) => r.id)).toEqual(['lib']);
    expect(roomScoped.map((r) => r.id)).toEqual(['mine']);
  });

  it('offers what is not attached yet, by name, matching name, type or description', () => {
    const library = [
      resource({ id: 'b', name: 'Beta', kind: 'references', typeLabel: 'GitHub' }),
      resource({ id: 'a', name: 'Alpha', description: 'design notes' }),
      resource({ id: 'c', name: 'Gamma' }),
    ];
    const attached = [resource({ id: 'c' })];
    expect(attachableResources(library, attached, '').map((r) => r.id)).toEqual(['a', 'b']);
    expect(attachableResources(library, attached, 'github').map((r) => r.id)).toEqual(['b']);
    expect(attachableResources(library, attached, ' DESIGN ').map((r) => r.id)).toEqual(['a']);
  });
});
