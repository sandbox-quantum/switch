/**
 * Which surface an event came from, as the agent sees it.
 *
 * A connection covering several rooms puts a Slack channel and an email
 * correspondent in one context window. Session-per-room used to make that
 * impossible, which gave the agent an accidental confidentiality boundary: the
 * session answering in a channel had never seen the private DM, so it could not
 * repeat it. Covering both on purpose removes that, and nothing replaces it
 * unless the agent can tell the two rooms apart.
 *
 * So every event carries the room it came from and who can read a reply posted
 * there. The label is derived, not stored: `channel_type` is already on the
 * event envelope and the bridge is already known, so an agent knows a DM is a
 * DM without anything being persisted or migrated.
 */

/**
 * Who can read what is said in a room.
 *
 * `private < restricted < open` orders how many people that is. `external` is
 * orthogonal rather than a fourth step — an email room holds one correspondent,
 * smaller than any channel, and is still the one place content must not travel
 * to unasked.
 *
 * `unknown` is what an uncharacterisable room gets. Guessing `open` or
 * `external` would be a claim about who can read the room, and a wrong claim in
 * the narrow direction is a disclosure nobody sees. The flow rule treats it as
 * the widest audience, so over-restricting costs a refusal a human can
 * authorise while under-restricting costs a leak.
 */
export type Audience = 'private' | 'restricted' | 'open' | 'external' | 'unknown';

export interface SurfaceInput {
  /** The room's `channel_type` from the event envelope, when it has one. */
  channelType?: string | null;
  /** Whether this room's bridge carries someone outside the organisation. */
  bridgeIsExternal?: boolean;
}

const BY_CHANNEL_TYPE: Record<string, Audience> = {
  direct: 'private',
  channel_private: 'restricted',
  group: 'restricted',
  channel_public: 'open',
  lobby: 'open',
};

export function audienceOf({ channelType, bridgeIsExternal }: SurfaceInput): Audience {
  if (bridgeIsExternal) return 'external';
  if (!channelType) return 'unknown';
  return BY_CHANNEL_TYPE[channelType] ?? 'unknown';
}

export interface SurfaceMetaInput extends SurfaceInput {
  roomId: string;
  /** Resolved from `list_rooms`; `room_name` on the envelope is specified but
   * not implemented, so a room we have just been given may not have one yet. */
  roomName?: string | null;
}

/**
 * The surface fields to merge into a notification's meta.
 *
 * Every value is a string: the runtime's meta is a flat `Record<string,
 * string>`, and anything else is stringified inconsistently by the host rather
 * than rejected.
 */
export function surfaceMeta({
  roomId,
  roomName,
  channelType,
  bridgeIsExternal,
}: SurfaceMetaInput): Record<string, string> {
  return {
    room_id: roomId,
    // Falling back to the id rather than omitting the field: an event labelled
    // with an audience but no name leaves the agent nothing to call the surface.
    room_name: roomName || roomId,
    audience: audienceOf({ channelType, bridgeIsExternal }),
  };
}
