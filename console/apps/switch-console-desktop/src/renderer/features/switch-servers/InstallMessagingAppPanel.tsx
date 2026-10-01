import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';

/** How often to look for the new connection while the user is in the browser. */
export const INSTALL_POLL_INTERVAL_MS = 3000;

type InstalledBridge = { bridgeId: string; displayName: string };

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; knownBridgeIds: ReadonlySet<string>; authorizeUrl: string };

type Props = {
  workspaceId: string;
  platform: string;
  onInstalled: (bridge: InstalledBridge) => void;
};

/**
 * Install the deployment's own app for `platform` into the workspace.
 *
 * The platform's consent screen runs in the user's browser and the server
 * finishes the install on its public callback, so nothing is handed back to
 * Switch Console. The only sign it worked is a new bridge of that platform, so
 * the panel notes which bridges existed before and watches for one it has not
 * seen.
 */
export function InstallMessagingAppPanel({ workspaceId, platform, onInstalled }: Props) {
  const label = bridgePlatformLabel(platform);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const waiting = phase.kind === 'waiting';
  const bridgesQuery = useQuery({
    queryKey: ['messaging-app-install-wait', workspaceId, platform],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
    enabled: waiting,
    refetchInterval: waiting ? INSTALL_POLL_INTERVAL_MS : false,
    gcTime: 0,
  });

  useEffect(() => {
    if (phase.kind !== 'waiting' || !bridgesQuery.data) return;
    const installed = bridgesQuery.data.find(
      (b) => b.type === platform && !phase.knownBridgeIds.has(b.id)
    );
    if (installed) onInstalled({ bridgeId: installed.id, displayName: installed.displayName });
  }, [phase, bridgesQuery.data, platform, onInstalled]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    setError(null);
    try {
      const before = await rpc.workspaces.listBridges(workspaceId);
      const authorizeUrl = await rpc.workspaces.beginMessagingAppInstall({ workspaceId, platform });
      const opened = await openExternalUrl(authorizeUrl, `Could not open ${label}`);
      if (!opened) {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'waiting', knownBridgeIds: new Set(before.map((b) => b.id)), authorizeUrl });
    } catch (cause) {
      setPhase({ kind: 'idle' });
      setError(failureText(cause, `Could not start adding ${label}.`));
    }
  };

  if (phase.kind === 'waiting') {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Waiting for {label}…
        </p>
        <p className="text-xs text-foreground-muted">
          Approve the Switch app in the browser window that opened. This connection appears here as
          soon as {label} confirms it.
        </p>
        <button
          type="button"
          className="w-fit text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternalUrl(phase.authorizeUrl, `Could not open ${label}`)}
        >
          Open the {label} page again
        </button>
        {bridgesQuery.isError && (
          <p className="text-xs text-destructive">
            {failureText(
              bridgesQuery.error,
              `Could not check whether ${label} is connected yet; still trying`
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-muted">
        Adds this Switch server’s own {label} app to your {label} workspace. {label} asks you to
        approve it in your browser; there are no tokens to copy.
      </p>
      <Button className="w-fit" onClick={() => void start()} disabled={phase.kind === 'starting'}>
        {hasBridgeIcon(platform) && <BridgeIcon bridgeType={platform} size={16} />}
        {phase.kind === 'starting' ? `Opening ${label}…` : `Add to ${label}`}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
