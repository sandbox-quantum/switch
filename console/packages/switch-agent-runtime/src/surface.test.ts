import { describe, expect, it } from 'vitest';
import { type Audience, audienceOf, surfaceMeta } from './surface';

/**
 * Which surface an event came from, as the agent sees it.
 *
 * A connection covering several rooms puts a Slack channel and an email
 * correspondent in one context window. The model cannot be discreet about a
 * boundary it cannot see, so every event it is handed has to say where it came
 * from and who can read a reply posted there.
 *
 * This lives in its own module because `bin.ts` reads config at module scope
 * and exits from it, so it cannot be imported — anything that needs a unit
 * test has to sit outside it.
 *
 * The label is derived, not stored: `channel_type` is already on the event
 * envelope, and the bridge is already known. Nothing new has to be persisted
 * or migrated for the agent to know a DM is a DM.
 */

describe('audienceOf', () => {
  it('reads a direct room as private', () => {
    expect(audienceOf({ channelType: 'direct' })).toBe<Audience>('private');
  });

  it('reads a closed group as restricted', () => {
    expect(audienceOf({ channelType: 'channel_private' })).toBe<Audience>('restricted');
    expect(audienceOf({ channelType: 'group' })).toBe<Audience>('restricted');
  });

  it('reads an open channel as open', () => {
    expect(audienceOf({ channelType: 'channel_public' })).toBe<Audience>('open');
    expect(audienceOf({ channelType: 'lobby' })).toBe<Audience>('open');
  });

  it('reads a room on an external bridge as external, whatever its type', () => {
    /**
     * `external` is orthogonal to the size ordering, not a step in it. An email
     * room holds one correspondent — smaller than any channel — and is still
     * the one place content must not travel to without being asked.
     */
    expect(audienceOf({ channelType: 'direct', bridgeIsExternal: true })).toBe<Audience>(
      'external'
    );
    expect(audienceOf({ channelType: 'channel_public', bridgeIsExternal: true })).toBe<Audience>(
      'external'
    );
  });

  it('says unknown rather than guessing when the type is missing', () => {
    /**
     * Not `open`, and not `external` either — both would be a claim about who
     * can read the room, and a wrong claim in the narrow direction is a
     * disclosure nobody sees.
     *
     * `unknown` is honest and the flow rule treats it as the widest audience,
     * so content does not travel into it unasked. Over-restricting costs a
     * refusal a human can authorize; under-restricting costs a leak.
     */
    expect(audienceOf({})).toBe<Audience>('unknown');
    expect(audienceOf({ channelType: null })).toBe<Audience>('unknown');
    expect(audienceOf({ channelType: 'something-new' })).toBe<Audience>('unknown');
  });
});

describe('surfaceMeta', () => {
  it('names the room and its audience', () => {
    const meta = surfaceMeta({
      roomId: '!abc:switch.local',
      roomName: 'Slack: #summit-2027',
      channelType: 'channel_public',
    });

    expect(meta).toMatchObject({
      room_id: '!abc:switch.local',
      room_name: 'Slack: #summit-2027',
      audience: 'open',
    });
  });

  it('falls back to the room id when the name is not known yet', () => {
    /**
     * `room_name` on the envelope is specified but not implemented, so the
     * client resolves names itself and may not have one for a room it has just
     * been given. A missing name must not drop the field — the agent would
     * then have a labelled event with nothing to call the surface.
     */
    const meta = surfaceMeta({ roomId: '!abc:switch.local', channelType: 'direct' });

    expect(meta.room_name).toBe('!abc:switch.local');
    expect(meta.audience).toBe('private');
  });

  it('always carries an audience, even for a room it cannot characterise', () => {
    const meta = surfaceMeta({ roomId: '!abc:switch.local' });

    expect(meta.audience).toBe('unknown');
  });

  it('returns only string values, so it can merge into notification meta', () => {
    /**
     * The runtime's notification meta is a flat `Record<string, string>`. A
     * non-string here would be dropped or stringified inconsistently by the
     * host rather than rejected.
     */
    const meta = surfaceMeta({
      roomId: '!abc:switch.local',
      roomName: 'Email: vendor',
      channelType: 'direct',
      bridgeIsExternal: true,
    });

    for (const value of Object.values(meta)) {
      expect(typeof value).toBe('string');
    }
    expect(meta.audience).toBe('external');
  });
});
