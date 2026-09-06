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
  /**
   * The audience the server computed, when it sent one.
   *
   * Preferred over anything derivable here. The server knows the bridge's type
   * and this side does not, so deriving locally cannot distinguish an email
   * room from an ordinary DM — and getting that wrong in the narrow direction
   * is the disclosure nobody sees. The fields below remain only as the fallback
   * for an envelope from a server that predates this.
   */
  audience?: string | null;
  /** The room's `channel_type` from the event envelope, when it has one. */
  channelType?: string | null;
  /**
   * Whether this room's bridge carries someone outside the organisation.
   *
   * Three-valued on purpose: `true`, `false`, or **not known**. Making it a
   * required boolean was meant to force every caller to answer — and both
   * callers answered `false`, because the event envelope carries `bridge_id`
   * but not the bridge *type*, so neither can actually tell. A required flag
   * that can only be answered with a guess collects guesses.
   *
   * Undefined therefore means unknown and yields `unknown`, not `internal`.
   * The real fix is for the server to send the audience it already computes —
   * it knows which bridges are external — which would delete this side of a
   * rule currently written twice in two languages.
   */
  bridgeIsExternal?: boolean;
}

// A Map, not an object literal: `BY_CHANNEL_TYPE['constructor']` on a literal
// resolves through the prototype and returns a function, which `?? 'unknown'`
// never sees. `channel_type` is server-controlled, so that is not a live
// exposure — but a lookup that can return a non-`Audience` while typed as one
// is worth not having.
const BY_CHANNEL_TYPE = new Map<string, Audience>([
  ['direct', 'private'],
  ['channel_private', 'restricted'],
  ['group', 'restricted'],
  ['channel_public', 'open'],
  ['lobby', 'open'],
]);

const AUDIENCES: ReadonlySet<string> = new Set([
  'private',
  'restricted',
  'open',
  'external',
  'unknown',
]);

export function audienceOf({ audience, channelType, bridgeIsExternal }: SurfaceInput): Audience {
  // A value we do not recognise is a newer server naming something this build
  // has no rule for. `unknown` is the honest answer, not a guess at which of
  // ours it resembles.
  if (audience) return AUDIENCES.has(audience) ? (audience as Audience) : 'unknown';
  if (bridgeIsExternal) return 'external';
  if (!channelType) return 'unknown';

  // Reached only for an envelope carrying no audience — that is, from a server
  // predating the field, which is also a server predating the email bridge, so
  // there is no external correspondent for it to be wrong about. Returning
  // `unknown` for everything here instead would be safe and would cost every
  // label on every room until that server is upgraded.
  //
  // `direct` is the exception: it is the shape an email room takes, so if a
  // newer server ever omits the field this is the one answer worth withholding.
  if (channelType === 'direct' && bridgeIsExternal === undefined) return 'unknown';
  return BY_CHANNEL_TYPE.get(channelType) ?? 'unknown';
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
  audience,
  channelType,
  bridgeIsExternal,
}: SurfaceMetaInput): Record<string, string> {
  return {
    room_id: roomId,
    // Omitted when unknown rather than falling back to the id. The id is
    // already in the same object, so a fallback adds nothing an agent could
    // not read — and `room_name: "!abc:server"` does not read as "no name
    // available", it reads as the room being called that.
    ...(roomName ? { room_name: roomName } : {}),
    audience: audienceOf({ audience, channelType, bridgeIsExternal }),
  };
}
