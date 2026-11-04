import { createRoom, GatewayError } from '@main/core/switch-servers/gateway-client';
import type {
  CreateRoomParams,
  CreateRoomResult,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';

/** The gateway reports an unknown bridge id and a configured-but-stopped bridge
 * with the same 400, differing only in wording. Both mean "you cannot bridge to
 * that right now", which is the one failure the user can act on directly.
 *
 * A room that cannot be created because the chosen bridge cannot make a
 * channel (withheld by the operator, or the platform never supports it) is a
 * different failure — the bridge itself is fine — so it falls through to
 * `invalid` below rather than matching here. Both of those messages name the
 * platform or connection, never the word "bridge", so this regex does not
 * need to exclude them explicitly; `CreateRoomModal` already keeps
 * channel-incapable bridges out of the picker, so a live user only hits this
 * path in the race between loading the list and an operator's edit landing.
 */
function isBridgeFailure(detail: string): boolean {
  return /bridge/i.test(detail) && /not running|unavailable|not found/i.test(detail);
}

const EXISTING_CHANNEL_REFUSED =
  'Switch couldn’t use that channel. Check the id, that the Switch app is in the channel, and that no other room already uses it.';

/**
 * Create a room on `server` and map recoverable gateway failures onto a typed
 * {@link CreateRoomResult}, so the modal can name what went wrong instead of
 * surfacing a raw status line — or worse, appearing to do nothing.
 *
 * Unmapped failures still throw: any other unexpected 500 is a bug, not a form error,
 * and should reach the logs rather than be flattened into the same inline
 * message as a typo in the room name.
 */
export async function createRoomOnServer(
  server: SwitchServer,
  params: Omit<CreateRoomParams, 'workspaceId'>
): Promise<CreateRoomResult> {
  try {
    const room = await createRoom(server, {
      name: params.name,
      description: params.description,
      instructions: params.instructions,
      bridgeId: params.bridgeId,
      agentIds: params.agentIds,
      channel: params.channel,
      groupId: params.groupId,
      access: params.access,
    });
    return { kind: 'created', room };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && (cause.status === 400 || cause.status === 422)) {
        const message = cause.detail ?? cause.message;
        return isBridgeFailure(message)
          ? { kind: 'bridge-unavailable', message }
          : { kind: 'invalid', message };
      }
      // The messaging app turned the request down (`BridgeOperationError`).
      if (cause.kind === 'http' && cause.status === 502)
        return {
          kind: 'error',
          message: `The messaging app could not make the room: ${cause.detail ?? cause.message}`,
        };
      // A named channel the server cannot use fails as a fault rather than a
      // 400: an id the app does not know, a channel its bot is not in, or one
      // another room already uses. Said so, since Console is where the id was typed.
      if (cause.kind === 'http' && cause.status === 500 && params.channel?.kind === 'existing')
        return { kind: 'invalid', message: EXISTING_CHANNEL_REFUSED };
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
