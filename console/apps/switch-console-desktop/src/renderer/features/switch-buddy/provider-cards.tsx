import { CircleAlert, ExternalLink } from 'lucide-react';
import { LogTail } from '@renderer/features/switch-servers/log-tail';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import { requireProvider } from '@shared/core/providers/agent-provider-registry';
import { linksIn } from '@shared/core/providers/provider-login';
import type { BuddyProvider } from './buddy-providers';
import type { Login, SetupBusy } from './use-provider-setup';
import type { ThisComputer } from './use-this-computer';

/*
 * What the provider card draws: this computer's state, a card per provider,
 * and what the selected one needs next. Nothing here acts; `ProviderSetup`
 * hands each its state and handlers from `useProviderSetup`.
 */

export function ComputerNote({ computer }: { computer: ThisComputer }) {
  if (computer.kind === 'ready') return null;
  if (computer.kind === 'failed')
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{computer.error}</span>
      </p>
    );
  return (
    <p className="flex items-center gap-2 text-sm text-foreground-muted">
      <Spinner className="size-3.5" />
      Getting this computer ready to run switch-buddy…
    </p>
  );
}

const TAG: Record<BuddyProvider['state'], string> = {
  ready: 'Signed in locally',
  'sign-in': 'Not signed in',
  install: 'Not installed',
  checking: 'Checking…',
};

export function ProviderCard({
  provider,
  selected,
  disabled,
  onSelect,
}: {
  provider: BuddyProvider;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled || provider.state === 'checking'}
        onClick={onSelect}
        className={cn(
          'flex h-full w-full flex-col items-start gap-3 rounded-xl border bg-background/80 p-4 text-left disabled:opacity-60',
          selected ? 'border-foreground' : 'border-border hover:bg-[var(--sel-soft)]'
        )}
      >
        <AgentIcon id={provider.id} size={28} />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium text-foreground">{provider.name}</span>
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs',
              provider.state === 'ready' ? 'text-emerald-600' : 'text-foreground-muted'
            )}
          >
            {provider.state === 'checking' && <Spinner className="size-3" />}
            {TAG[provider.state]}
          </span>
        </span>
      </button>
    </li>
  );
}

export function SelectedPanel({
  provider,
  login,
  busy,
  onStart,
  onSignIn,
  onCancelSignIn,
  onInstall,
  onCheckAgain,
  checked,
}: {
  provider: BuddyProvider;
  login: Login | null;
  /** What the last Check again found, or null. */
  checked: string | null;
  busy: SetupBusy;
  onStart: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onInstall: () => void;
  onCheckAgain: () => void;
}) {
  const loginCommand = requireProvider(provider.id).loginCommand;
  switch (provider.state) {
    case 'ready':
      return (
        <>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Use the account signed in here</p>
            <p className="text-xs text-foreground-muted">
              switch-buddy runs on this computer with your {provider.name} sign-in. Nothing is
              uploaded.
            </p>
          </div>
          <div>
            <Button onClick={onStart} disabled={busy !== null}>
              {busy === 'create' && <Spinner className="size-3.5" />}
              {busy === 'create' ? 'Creating switch-buddy…' : `Start with ${provider.name}`}
            </Button>
          </div>
        </>
      );
    case 'install':
      return (
        <>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {provider.name} isn’t installed on this computer
            </p>
            <p className="text-xs text-foreground-muted">
              Switch Console can install it for you. You’ll sign in to it next.
            </p>
          </div>
          <div>
            <Button onClick={onInstall} disabled={busy !== null}>
              {busy === 'install' && <Spinner className="size-3.5" />}
              {busy === 'install' ? `Installing ${provider.name}…` : `Install ${provider.name}`}
            </Button>
          </div>
        </>
      );
    case 'sign-in': {
      const running = login !== null && login.ended === null;
      const links = login ? linksIn(login.lines) : [];
      return (
        <>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Sign in to {provider.name} on this computer
            </p>
            <p className="text-xs text-foreground-muted">
              {running
                ? 'Finish signing in in your browser. This page moves on by itself once it’s done.'
                : 'It opens your browser to sign in with your own account.'}
            </p>
            {provider.detail && !running && (
              <p className="text-xs text-foreground-warning">{provider.detail}</p>
            )}
          </div>
          {login && <LogTail lines={login.lines} placeholder="Starting the sign-in…" />}
          {links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {links.map((link) => (
                <Button
                  key={link}
                  variant="outline"
                  size="sm"
                  onClick={() => void openExternalUrl(link, 'Could not open the sign-in page')}
                >
                  <ExternalLink className="size-3.5" />
                  Open sign-in page
                </Button>
              ))}
            </div>
          )}
          {login?.ended && !login.ended.ok && (
            <p className="text-xs text-destructive">
              {login.ended.error ?? `${loginCommand} ended without signing in.`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <Button variant="outline" onClick={onCancelSignIn}>
                Cancel
              </Button>
            ) : (
              <Button onClick={onSignIn} disabled={busy !== null}>
                Sign in
              </Button>
            )}
            <Button variant="ghost" onClick={onCheckAgain} disabled={busy !== null || running}>
              {busy === 'check' && <Spinner className="size-3.5" />}
              Check again
            </Button>
          </div>
          {checked && !running && <p className="text-xs text-foreground-muted">{checked}</p>}
          <p className="text-xs text-foreground-muted">
            Or run <code className="rounded bg-background-tertiary px-1">{loginCommand}</code> in a
            terminal, then press Check again.
          </p>
        </>
      );
    }
    case 'checking':
      return (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          Checking {provider.name} on this computer…
        </p>
      );
  }
}
