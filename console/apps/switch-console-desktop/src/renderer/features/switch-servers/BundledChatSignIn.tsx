import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound } from 'lucide-react';
import { useCallback, useState } from 'react';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { DropdownMenuItem } from '@renderer/lib/ui/dropdown-menu';
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

/**
 * The bundled chat's address and sign-in, for signing in outside Switch Console —
 * a browser or the desktop Mattermost client (CHOO-1787).
 *
 * Both are on the same machine by necessity: the stack publishes onto loopback
 * so it is never exposed to the LAN, so the copy must not invite the user to
 * try a device that cannot reach it.
 *
 * The values are only fetched once the dialog is opened: the password should
 * not cross into the renderer for everyone who merely looks at the server page.
 * When Switch Console cannot read the real values it says which one is missing
 * and why, and shows nothing else — a template password would only send the
 * user round a login loop.
 */
export function BundledChatSignIn({
  serverId,
  bridgeDisplayName,
  asMenuItem = false,
}: {
  serverId: string;
  bridgeDisplayName: string;
  /** Render the opener as a dropdown entry rather than a standalone icon
   * button, for the row menu that now carries this action. */
  asMenuItem?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const signInQuery = useQuery({
    queryKey: ['bundled-chat-sign-in', serverId],
    queryFn: () => rpc.switchServers.getBundledChatSignIn(serverId),
    // The password only crosses into the renderer once the dialog is actually
    // opened, so merely listing the app never fetches it.
    enabled: open,
  });

  const signIn = signInQuery.data;
  const url = signIn?.kind === 'available' ? signIn.url : null;

  return (
    <>
      {asMenuItem ? (
        // `closeOnClick={false}` would leave the menu over the dialog; letting
        // it close and opening the dialog from the same click is what keeps one
        // surface on screen at a time.
        <DropdownMenuItem onClick={() => setOpen(true)}>
          <KeyRound className="size-4" />
          Sign-in details…
        </DropdownMenuItem>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${bridgeDisplayName} sign-in details`}
          title={`${bridgeDisplayName} sign-in details`}
          onClick={() => setOpen(true)}
        >
          <KeyRound className="size-3" />
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <BridgeIcon bridgeType="mattermost" size={16} />
            <DialogTitle>{bridgeDisplayName} sign-in details</DialogTitle>
          </DialogHeader>
          <DialogContentArea className="space-y-3">
            <DialogDescription>
              Use these to sign in to this chat in a browser or the {bridgeDisplayName} desktop app
              on this computer.
            </DialogDescription>

            {signInQuery.isLoading ? (
              <Spinner className="size-3.5" />
            ) : signInQuery.isError ? (
              <p className="text-destructive text-xs">
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
            <DialogClose render={<Button size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
