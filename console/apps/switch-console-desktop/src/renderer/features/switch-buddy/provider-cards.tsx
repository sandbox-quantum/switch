import { ProviderChoiceCard } from '@switch-console/chat-ui/components/provider-choice';
import { CircleAlert, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { LogTail } from '@renderer/features/switch-servers/log-tail';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { Input } from '@switch-console/chat-ui/primitives/input';
import { Spinner } from '@switch-console/chat-ui/primitives/spinner';
import { requireProvider } from '@shared/core/providers/agent-provider-registry';
import { asksForCode, linksIn } from '@shared/core/providers/provider-login';
import type { BuddyProvider } from './buddy-providers';
import type { Login, SetupBusy } from './use-provider-setup';
import type { ThisComputer } from './use-this-computer';

/*
 * What the provider card draws: this computer's state, a card per provider,
 * and what the selected one needs next. Nothing here acts; `ProviderSetup`
 * hands each its state and handlers from `useProviderSetup`.
 */

export function ComputerNote({
  computer,
  onRetry,
}: {
  computer: ThisComputer;
  onRetry: () => void;
}) {
  if (computer.kind === 'ready') return null;
  if (computer.kind === 'failed')
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{computer.error}</span>
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
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
    <ProviderChoiceCard
      icon={<AgentIcon id={provider.id} size={28} />}
      name={provider.name}
      tag={
        provider.state === 'sign-in' && !provider.loginHelps
          ? 'Can’t be used yet'
          : TAG[provider.state]
      }
      tone={
        provider.state === 'ready' ? 'ready' : provider.state === 'checking' ? 'checking' : 'plain'
      }
      selected={selected}
      disabled={disabled || provider.state === 'checking'}
      onSelect={onSelect}
      signIn={null}
    />
  );
}

export function SelectedPanel({
  provider,
  login,
  busy,
  onStart,
  onSignIn,
  onCancelSignIn,
  onSignInCode,
  onInstall,
  installFailed = false,
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
  /** Sends the code a sign-in page showed to the running sign-in command. */
  onSignInCode: (code: string) => void;
  onInstall: () => void;
  /** The last install of this provider failed: offer installing it by hand. */
  installFailed?: boolean;
  onCheckAgain: () => void;
}) {
  const { loginCommand, docUrl } = requireProvider(provider.id);
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
              {installFailed
                ? `You can install it yourself instead, then press Check again.`
                : 'Switch Console can install it for you. You’ll sign in to it next.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={installFailed ? 'outline' : 'default'}
              onClick={onInstall}
              disabled={busy !== null}
            >
              {busy === 'install' && <Spinner className="size-3.5" />}
              {busy === 'install'
                ? `Installing ${provider.name}…`
                : installFailed
                  ? 'Try again'
                  : `Install ${provider.name}`}
            </Button>
            {installFailed && (
              <Button
                variant="outline"
                onClick={() =>
                  void openExternalUrl(docUrl, `Could not open how to install ${provider.name}`)
                }
              >
                <ExternalLink className="size-3.5" />
                How to install {provider.name}
              </Button>
            )}
            {/* Also when nothing failed: a CLI installed outside Console is only found on a check. */}
            <Button variant="ghost" onClick={onCheckAgain} disabled={busy !== null}>
              {busy === 'check' && <Spinner className="size-3.5" />}
              Check again
            </Button>
          </div>
          {checked && <p className="text-xs text-foreground-muted">{checked}</p>}
        </>
      );
    case 'sign-in': {
      const running = login !== null && login.ended === null;
      // A sign-in already under way stays, with its Cancel, whatever the report says now.
      if (!provider.loginHelps && !running)
        return (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {provider.name} can’t be used on this computer yet
              </p>
              {provider.detail && (
                <p className="text-xs text-foreground-warning">{provider.detail}</p>
              )}
            </div>
            <div>
              <Button variant="ghost" onClick={onCheckAgain} disabled={busy !== null}>
                {busy === 'check' && <Spinner className="size-3.5" />}
                Check again
              </Button>
            </div>
            {checked && <p className="text-xs text-foreground-muted">{checked}</p>}
          </>
        );
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
          {login && running && asksForCode(login.lines) && (
            <SignInCodeForm onSubmit={onSignInCode} />
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

/** Where to paste the code a sign-in page showed, for the command waiting on it. */
function SignInCodeForm({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim()) return;
        onSubmit(code);
        setCode('');
      }}
    >
      <p className="w-full text-xs text-foreground-muted">
        Only if the sign-in page shows you a code instead of saying you’re signed in:
      </p>
      <Input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="Paste the code here"
        aria-label="Sign-in code"
        className="h-8 flex-1"
      />
      <Button type="submit" size="sm" disabled={!code.trim()}>
        Send code
      </Button>
    </form>
  );
}
