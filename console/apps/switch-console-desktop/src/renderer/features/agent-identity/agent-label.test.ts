import { describe, expect, it } from 'vitest';
import { labelFollowsName, labelFromName } from './agent-label';

describe('labelFromName', () => {
  it('writes a name out as a label', () => {
    expect(labelFromName('notes-helper')).toBe('Notes Helper');
    expect(labelFromName('release_captain.v2')).toBe('Release Captain V2');
    expect(labelFromName('a--b')).toBe('A B');
  });
});

describe('labelFollowsName', () => {
  it('follows only a label that is the name written out', () => {
    expect(labelFollowsName('Notes Helper', 'notes-helper')).toBe(true);
    expect(labelFollowsName('Scribe', 'notes-helper')).toBe(false);
    expect(labelFollowsName(null, 'notes-helper')).toBe(false);
    expect(labelFollowsName('', 'notes-helper')).toBe(false);
  });
});
