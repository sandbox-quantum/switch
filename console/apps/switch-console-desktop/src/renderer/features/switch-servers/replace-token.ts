import type {
  BridgeConfigField,
  BridgeInstallState,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';

/** The credentials a connection on someone's own app holds, all asked for
 * again: the platform's secret fields, as its schema marks them. */
export function tokenFields(fields: readonly BridgeConfigField[]): BridgeConfigField[] {
  return fields
    .filter((field) => field.secret && field.kind === 'string')
    .map((field) => ({ ...field, required: true }));
}

/** Whether this connection may be worth asking about its install at all. A
 * connection on Switch's own app (the distributed Teams app, the Switch
 * Telegram app) says so on the bridge itself, and needs no further question. */
export function mayReplaceToken(
  bridge: RemoteBridge,
  fields: readonly BridgeConfigField[]
): boolean {
  return fields.length > 0 && !bridge.teamPlacementSupported && bridge.channelIdsRefused === null;
}

/**
 * Whether to offer replacing a connection's token.
 *
 * Only on a connection to the workspace's own bot. One that came from
 * installing Switch's app holds the deployment's credential, or none at all,
 * and the server refuses a token pasted onto it. An install is what marks that
 * kind of connection, so a connection is offered the action only once the
 * server has said it has none; not knowing is not offering.
 */
export function offersTokenReplacement(
  bridge: RemoteBridge,
  fields: readonly BridgeConfigField[],
  installState: BridgeInstallState | undefined
): boolean {
  return mayReplaceToken(bridge, fields) && installState === 'not-installed';
}
