import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import type { ChatClaim, ClaimablePlatform } from '@shared/core/switch-servers/switch-servers';
import { INSTALL_POLL_INTERVAL_MS } from './InstallMessagingAppPanel';

type ConnectedBridge = { bridgeId: string; displayName: string };

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'shown'; claim: ChatClaim; knownBridgeIds: ReadonlySet<string> | null };

type Props = {
  workspaceId: string;
  claimable: ClaimablePlatform;
  /** Called once the link and code are on screen. */
  onShown: () => void;
  /** Called once the workspace's first chat has created its connection. */
  onConnected: (bridge: ConnectedBridge) => void;
};

/**
 * Connect a chat to the deployment's claim-based app for a platform (the
 * Switch Telegram app), from the Connect a messaging app dialog.
 *
 * The claim lands in the chat, not here, so nothing comes back when it works.
 * A workspace's first chat is the exception: it creates the connection, so the
 * panel notes which bridges existed before and hands over the new one, the way
 * an OAuth install does. Later chats only add rooms to a connection that is
 * already there, and the details stay up until the dialog is closed.
 */
export function ConnectChatPanel({ workspaceId, claimable, onShown, onConnected }: Props) {
  const { platform } = claimable;
  const label = bridgePlatformLabel(platform);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const watching = phase.kind === 'shown' && phase.knownBridgeIds !== null;
  const bridgesQuery = useQuery({
    queryKey: ['messaging-app-claim-wait', workspaceId, platform],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
    enabled: watching,
    refetchInterval: watching ? INSTALL_POLL_INTERVAL_MS : false,
    gcTime: 0,
  });

  useEffect(() => {
    if (phase.kind !== 'shown' || phase.knownBridgeIds === null || !bridgesQuery.data) return;
    const known = phase.knownBridgeIds;
    const created = bridgesQuery.data.find((b) => b.type === platform && !known.has(b.id));
    if (created) onConnected({ bridgeId: created.id, displayName: created.displayName });
  }, [phase, bridgesQuery.data, platform, onConnected]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    setError(null);
    try {
      const before = claimable.connected ? null : await rpc.workspaces.listBridges(workspaceId);
      const claim = await rpc.workspaces.beginChatClaim({ workspaceId, platform });
      setPhase({
        kind: 'shown',
        claim,
        knownBridgeIds: before === null ? null : new Set(before.map((b) => b.id)),
      });
      onShown();
    } catch (cause) {
      setPhase({ kind: 'idle' });
      setError(failureText(cause, `Could not start connecting a ${label} chat.`));
    }
  };

  if (phase.kind === 'shown') {
    return (
      <div className="flex flex-col gap-2">
        <ChatClaimDetails platform={platform} claim={phase.claim} />
        {watching && (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Loader2 className="size-3.5 animate-spin" />
            This connection appears here as soon as the first chat is connected.
          </p>
        )}
        {watching && bridgesQuery.isError && (
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
        Connects a {label} group or channel to this Switch server’s own {label} app. Each chat gets
        a room; there are no tokens to copy.
      </p>
      <Button className="w-fit" onClick={() => void start()} disabled={phase.kind === 'starting'}>
        {hasBridgeIcon(platform) && <BridgeIcon bridgeType={platform} size={16} />}
        {phase.kind === 'starting' ? 'Getting a link…' : `Add to ${label}`}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * How to use a claim: a link for a group, and the bot's handle and a command
 * for a channel. A channel carries nothing when a bot is added to it, so its
 * admin adds the bot by hand and posts the code; the handle is shown whole
 * because Telegram's search does not find a bot by part of it. The expiry is
 * said here because a link that quietly stopped working looks exactly like one
 * that never did.
 */
export function ChatClaimDetails({ platform, claim }: { platform: string; claim: ChatClaim }) {
  const label = bridgePlatformLabel(platform);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Button
          className="w-fit"
          onClick={() => void openExternalUrl(claim.url, `Could not open ${label}`)}
        >
          <ExternalLink className="size-4" />
          Add to a {label} group
        </Button>
        <p className="text-xs text-foreground-muted">
          Pick a group and confirm. The bot joins, Switch creates the group’s room, and the bot says
          in the group that it is connected.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 text-xs">
        <p>
          For a channel, open its Administrators, choose Add Admin, and search for the bot by its
          full username:
        </p>
        <CopyableValue value={claim.botHandle} label="the bot’s username" />
        <p>Keep its permission to post, save, then post this in the channel:</p>
        <CopyableValue value={`/connect ${claim.code}`} label="the command" />
        <p className="text-foreground-muted">
          Agents can always post to the channel. For posts in the channel to reach agents, turn on
          Sign Messages and Show Authors’ Profiles in its settings, and post as yourself rather than
          as the channel.
        </p>
      </div>

      <p className="rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
        The link and the code work once, for ten minutes. Anyone who has them in that time can
        connect a chat to this workspace, so share them only with people who should.
      </p>
    </div>
  );
}

function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 truncate rounded bg-background-quaternary-1 px-2 py-1 font-mono text-xs text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5 text-foreground-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}
