import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-foreground-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

/** One label + value + copy row. `secret` masks the value until revealed —
 * copying works either way, so the password never has to be on screen to be
 * used. */
function CredentialRow({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;

  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-foreground-muted">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-background-quaternary-1 px-2 py-1 font-mono text-xs text-foreground">
        {masked ? '••••••••••••' : value}
      </code>
      {secret && (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
      <CopyButton value={value} label={label} />
    </div>
  );
}

type BundledChatSignInModalArgs = {
  serverId: string;
  bridgeDisplayName: string;
};

type Props = BaseModalProps<void> & BundledChatSignInModalArgs;

/**
 * The bundled chat's address and sign-in, for signing in outside Switch Console —
 * a browser or the desktop Mattermost client (CHOO-1787).
 *
 * Both are on the same machine by necessity: the stack publishes onto loopback
 * so it is never exposed to the LAN, so the copy must not invite the user to
 * try a device that cannot reach it.
 *
 * It goes through the modal registry rather than owning a `Dialog` of its own,
 * because the only thing that opens it is an item in the messaging app's
 * dropdown menu. A dialog rendered there is a child of the menu's popup, which
 * base-ui unmounts the moment the menu closes — so the same click that opened
 * it took it away again.
 *
 * The values are only fetched once the dialog is opened: the password should
 * not cross into the renderer for everyone who merely looks at the server page.
 * When Switch Console cannot read the real values it says which one is missing
 * and why, and shows nothing else — a template password would only send the
 * user round a login loop.
 */
export function BundledChatSignInModal({ serverId, bridgeDisplayName, onClose }: Props) {
  const signInQuery = useQuery({
    queryKey: ['bundled-chat-sign-in', serverId],
    queryFn: () => rpc.switchServers.getBundledChatSignIn(serverId),
  });

  const signIn = signInQuery.data;
  const url = signIn?.kind === 'available' ? signIn.url : null;

  return (
    <>
      <DialogHeader>
        <BridgeIcon bridgeType="mattermost" size={16} />
        <DialogTitle>{bridgeDisplayName} sign-in details</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3">
        <DialogDescription>
          Use these to sign in to this chat in a browser or the {bridgeDisplayName} desktop app on
          this computer.
        </DialogDescription>

        {signInQuery.isLoading ? (
          <Spinner className="size-3.5" />
        ) : signInQuery.isError ? (
          <p className="text-xs text-destructive">
            {failureText(signInQuery.error, 'Could not read the sign-in details.')}
          </p>
        ) : signIn?.kind === 'unavailable' ? (
          <p className="text-xs text-foreground-muted">{signIn.reason}</p>
        ) : signIn?.kind === 'available' ? (
          <>
            <CredentialRow label="Server" value={signIn.url} />
            <CredentialRow label="Username" value={signIn.username} />
            <CredentialRow label="Password" value={signIn.password} secret />
          </>
        ) : null}
      </DialogContentArea>
      <DialogFooter>
        {url && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openExternalUrl(url, `Could not open ${bridgeDisplayName}`)}
          >
            <ExternalLink className="size-4" />
            Open in browser
          </Button>
        )}
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
