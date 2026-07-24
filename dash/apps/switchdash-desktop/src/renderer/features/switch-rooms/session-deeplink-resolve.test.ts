import { describe, expect, it, vi } from 'vitest';
import { pickDeeplinkTarget } from './session-deeplink-resolve';

type Match = { locationId: string; sessionId: string };

const byId: Match = { locationId: 'loc-by-id', sessionId: 's-1' };
const byRoom: Match = { locationId: 'loc-by-room', sessionId: 's-other' };

describe('pickDeeplinkTarget', () => {
  it('uses the exact session-id match when a session id is present', () => {
    expect(
      pickDeeplinkTarget(
        's-1',
        () => byId,
        () => byRoom
      )
    ).toBe(byId);
  });

  it('does NOT fall back to a room match when the session id is unresolved', () => {
    // The CHOO-1588 wrong-chat bug: a present-but-unresolved session id must
    // return null, not a different session that merely shares the room.
    expect(
      pickDeeplinkTarget(
        's-1',
        () => null,
        () => byRoom
      )
    ).toBeNull();
  });

  it('does not even run the room resolver when a session id is present', () => {
    const resolveByRoom = vi.fn(() => byRoom);
    pickDeeplinkTarget('s-1', () => byId, resolveByRoom);
    expect(resolveByRoom).not.toHaveBeenCalled();
  });

  it('falls back to room matching for older links with no session id', () => {
    expect(
      pickDeeplinkTarget(
        '',
        () => byId,
        () => byRoom
      )
    ).toBe(byRoom);
  });
});
