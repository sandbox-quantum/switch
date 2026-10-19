import { CircleAlert, ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogTail } from '@renderer/features/switch-servers/log-tail';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type { AgentInstallError } from '@shared/core/providers/agent-payload';
import { agentProviders, requireProvider } from '@shared/core/providers/agent-provider-registry';
import { linksIn } from '@shared/core/providers/provider-login';
import { providerLoginExitChannel, providerLoginLineChannel } from '@shared/events/appEvents';
import { type BuddyProvider, buddyProviders } from './buddy-providers';
import { reportBuddyStep } from './buddy-telemetry';
import { createBuddy } from './create-buddy';
import { type ThisComputer, useThisComputer } from './use-this-computer';

/** How many lines of a sign-in command's output are kept on screen. */
const KEPT_LINES = 40;

type Login = {
  attemptId: string;
  providerId: string;
  lines: string[];
  /** Null while it runs; then how it ended. */
  ended: { ok: boolean; error: string | null } | null;
};

/**
 * Pick the AI provider switch-buddy runs on, get it ready on this computer,
 * and create the buddy with it.
 *
 * What a provider needs is read from what this computer's agents controller
 * reports to Switch, which is what Switch checks before creating an agent.
 * Installing a CLI or signing it in is followed by asking the controller to
 * check again straight away, so the card moves on as soon as it is true
 * rather than at the controller's next check.
 */
export const ProviderSetup = observer(function ProviderSetup({
  serverId,
  workspaceId,
  onCreated,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
}) {
  const { state: computer, recheck } = useThisComputer(serverId, workspaceId);
  const providers = useMemo(
    () => buddyProviders(agentProviders(), computer.kind === 'ready' ? computer.machine : null),
    [computer]
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    providers.find((p) => p.id === picked) ??
    providers.find((p) => p.state === 'ready') ??
    providers.find((p) => p.state === 'sign-in') ??
    null;

  const [busy, setBusy] = useState<'install' | 'check' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  /** What the last Check again found, when it found nothing new: said, not left blank. */
  const [checked, setChecked] = useState<string | null>(null);

  const checkAgain = useCallback(async () => {
    reportBuddyStep('check_again', null);
    setBusy('check');
    setError(null);
    setChecked(null);
    try {
      setChecked(await recheck());
    } catch (cause) {
      setError(failureText(cause, 'Could not check this computer again.'));
    } finally {
      setBusy(null);
    }
  }, [recheck]);

  useEffect(() => {
    const offLine = events.on(providerLoginLineChannel, ({ attemptId, line }) =>
      setLogin((current) =>
        current?.attemptId === attemptId
          ? { ...current, lines: [...current.lines, line].slice(-KEPT_LINES) }
          : current
      )
    );
    const offExit = events.on(providerLoginExitChannel, ({ attemptId, exitCode, error: why }) => {
      let ours = false;
      setLogin((current) => {
        if (current?.attemptId !== attemptId) return current;
        ours = true;
        return { ...current, ended: { ok: exitCode === 0 && why === null, error: why } };
      });
      if (ours) void checkAgain();
    });
    return () => {
      offLine();
      offExit();
    };
  }, [checkAgain]);

  useEffect(() => () => void rpc.providers.cancelLogin(), []);

  const signIn = async (provider: BuddyProvider) => {
    reportBuddyStep('sign_in', provider.id);
    setError(null);
    try {
      const { attemptId } = await rpc.providers.startLogin(provider.id);
      setLogin({ attemptId, providerId: provider.id, lines: [], ended: null });
    } catch (cause) {
      setError(failureText(cause, `Could not start signing in to ${provider.name}.`));
    }
  };

  const install = async (provider: BuddyProvider) => {
    reportBuddyStep('install', provider.id);
    setBusy('install');
    setError(null);
    try {
      const result = await rpc.providers.install(provider.id);
      if (!result.success) setError(installFailure(provider.name, result.error));
      await recheck();
    } catch (cause) {
      setError(failureText(cause, `Could not install ${provider.name}.`));
    } finally {
      setBusy(null);
    }
  };

  const start = async (provider: BuddyProvider) => {
    if (computer.kind !== 'ready') return;
    reportBuddyStep('start', provider.id);
    setBusy('create');
    setError(null);
    const user = switchServersStore.statusFor(serverId)?.user ?? null;
    try {
      onCreated(
        await createBuddy({
          serverId,
          workspaceId,
          machineId: computer.machine.id,
          provider: provider.id,
          person: { name: user?.name ?? null, email: user?.email ?? null },
        })
      );
    } catch (cause) {
      setError(failureText(cause, 'Could not create switch-buddy.'));
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ComputerNote computer={computer} />
      <p className="text-sm text-foreground">Pick an AI provider to power switch-buddy:</p>
      <ul className="grid gap-3 sm:grid-cols-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            selected={selected?.id === provider.id}
            disabled={busy !== null || (login !== null && login.ended === null)}
            onSelect={() => setPicked(provider.id)}
          />
        ))}
      </ul>

      {selected && computer.kind === 'ready' && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/80 p-4">
          <SelectedPanel
            provider={selected}
            login={login?.providerId === selected.id ? login : null}
            busy={busy}
            onStart={() => void start(selected)}
            onSignIn={() => void signIn(selected)}
            onCancelSignIn={() => {
              void rpc.providers.cancelLogin();
              setLogin(null);
              setChecked(null);
            }}
            checked={checked}
            onInstall={() => void install(selected)}
            onCheckAgain={() => void checkAgain()}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
});

function ComputerNote({ computer }: { computer: ThisComputer }) {
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

function ProviderCard({
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

function SelectedPanel({
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
  busy: 'install' | 'check' | 'create' | null;
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

function installFailure(name: string, error: AgentInstallError): string {
  switch (error.type) {
    case 'not-detected-after-install':
      return `${name} was installed, but this computer can’t find it yet. Open a new terminal and check it runs, then press Check again.`;
    case 'no-install-command':
    case 'unknown-dependency':
      return `Switch Console can’t install ${name} on this computer. Install it yourself, then press Check again.`;
    case 'permission-denied':
    case 'command-failed':
    case 'process-open-failed':
      return `Installing ${name} failed: ${error.message}`;
  }
}
