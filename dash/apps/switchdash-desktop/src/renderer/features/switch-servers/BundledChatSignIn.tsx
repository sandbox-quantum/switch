import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
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
 * The bundled chat's address and sign-in, for signing in outside switchdash —
 * a browser or the desktop Mattermost client (CHOO-1787).
 *
 * Both are on the same machine by necessity: the stack publishes onto loopback
 * so it is never exposed to the LAN, so the copy must not invite the user to
 * try a device that cannot reach it.
 *
 * Collapsed by default, and the values are only fetched once it is opened: the
 * password should not cross into the renderer for everyone who merely looks at
 * the server page. When switchdash cannot read the real values it says which
 * one is missing and why, and shows nothing else — a template password would
 * only send the user round a login loop.
 */
export function BundledChatSignIn({ serverId }: { serverId: string }) {
  const [expanded, setExpanded] = useState(false);

  const signInQuery = useQuery({
    queryKey: ['bundled-chat-sign-in', serverId],
    queryFn: () => rpc.switchServers.getBundledChatSignIn(serverId),
    enabled: expanded,
  });

  const signIn = signInQuery.data;

  return (
    <div className="mt-1 ml-6">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0.5 text-xs text-foreground-muted"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Sign-in details
      </Button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-foreground-muted">
            Use these to sign in to this chat in a browser or the Mattermost desktop app on this
            computer.
          </p>

          {signInQuery.isLoading ? (
            <Spinner className="size-3.5" />
          ) : signInQuery.isError ? (
            <p className="text-destructive text-xs">
              Could not read the sign-in details:{' '}
              {signInQuery.error instanceof Error
                ? signInQuery.error.message
                : String(signInQuery.error)}
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
        </div>
      )}
    </div>
  );
}
