import type { RemoteBridge } from './switch-servers';

/**
 * Which of a local server's bridges is the Mattermost it bundles, as opposed
 * to a Mattermost the user connected themselves.
 *
 * - `bundled`: the one Mattermost bridge marked `preconfigured`, or, on a
 *   server none of whose Mattermost bridges is marked (older than the flag),
 *   the only Mattermost bridge there is.
 * - `none`: no Mattermost bridge at all.
 * - `ambiguous`: several Mattermost bridges and no single marked one, so
 *   nothing says which is bundled. Callers leave every bridge alone.
 *
 * The same rule as `bundled_mattermost_bridge` in
 * `deploy/shared_resources/setup.py`, the seeder that registers and marks it.
 */
export type BundledBridgeChoice =
  | { kind: 'bundled'; bridge: RemoteBridge }
  | { kind: 'none' }
  | { kind: 'ambiguous'; bridgeIds: string[] };

export function bundledMattermostBridge(bridges: readonly RemoteBridge[]): BundledBridgeChoice {
  const mattermost = bridges.filter((bridge) => bridge.type === 'mattermost');
  const marked = mattermost.filter((bridge) => bridge.preconfigured === true);
  if (marked.length === 1) return { kind: 'bundled', bridge: marked[0] };
  if (marked.length === 0 && mattermost.length === 1) {
    return { kind: 'bundled', bridge: mattermost[0] };
  }
  if (mattermost.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', bridgeIds: mattermost.map((bridge) => bridge.id) };
}

/** The id of the bundled Mattermost bridge, or null when there is none or it
 * cannot be told apart from the others. */
export function bundledMattermostBridgeId(bridges: readonly RemoteBridge[]): string | null {
  const choice = bundledMattermostBridge(bridges);
  return choice.kind === 'bundled' ? choice.bridge.id : null;
}

export function ambiguousBundledBridgeMessage(bridgeIds: readonly string[]): string {
  return (
    `The server has ${bridgeIds.length} Mattermost bridges (${bridgeIds.join(', ')}) and ` +
    "none is marked as the local server's bundled one, so none of them is treated as bundled. " +
    'Mark the bundled one by setting `preconfigured` on it.'
  );
}
