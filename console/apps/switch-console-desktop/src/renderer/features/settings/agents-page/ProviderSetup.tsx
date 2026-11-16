import type { ManualStep } from '@switch-console/core/agents/provider-setup';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Info,
  Loader2,
  MoreHorizontal,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { useProviderSetupSnapshot } from '@renderer/lib/stores/use-provider-setup-snapshot';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';
import type {
  ProviderSetupAuthorization,
  ProviderSetupInstallation,
  ProviderSetupOperation,
  ProviderSetupRun,
  ProviderSetupSnapshot,
} from '@shared/core/provider-setup/provider-setup';
import { linksIn } from '@shared/core/providers/provider-login';
import { Rich } from './rich';
import { Disclosure, RunDetails } from './setup-activities';
import { SetupSteps, StepButton } from './setup-steps';

/** All is well, something needs doing (amber), something is on offer (blue), or under way. */
type Tone = 'done' | 'todo' | 'offer' | 'working';

const WORKING: Record<ProviderSetupOperation['kind'], string> = {
  check: 'Checking…',
  install: 'Installing…',
  verify: 'Testing the connection…',
  checkForUpdates: 'Checking for updates…',
  update: 'Updating…',
  uninstall: 'Uninstalling…',
  signIn: 'Signing in…',
};

// Done is the nominal state, so it stays quiet; only what needs doing stands out.
function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === 'working') return <Loader2 className="size-4 animate-spin text-foreground-muted" />;
  if (tone === 'done') return <CheckCircle2 className="size-4 text-foreground-muted" />;
  if (tone === 'offer') return <Info className="size-4 text-foreground-info" />;
  return <CircleAlert className="size-4 text-foreground-warning" />;
}

/** What needs doing, in a box of its own under the setup. */
function ActionBox({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">{children}</div>
  );
}

function sameOperation(a: ProviderSetupOperation | null, b: ProviderSetupOperation): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** The latest run of `operation`, where it is the latest run of all. */
function latestRunOf(snapshot: ProviderSetupSnapshot, operation: ProviderSetupOperation) {
  const run = snapshot.runs.at(-1);
  return run && sameOperation(run.operation, operation) ? run : undefined;
}

/** How `run` failed, for a person, where it did. */
function FailureNote({ run }: { run: ProviderSetupRun | undefined }) {
  if (!run?.failure) return null;
  return <p className="text-xs text-foreground-destructive">{run.failure.message}</p>;
}

/** The overall state, at the top of the box: what is under way, else what needs doing, else ready. */
function overallOf(
  snapshot: ProviderSetupSnapshot,
  used: ProviderSetupInstallation | undefined
): { tone: Tone; title: string } {
  if (snapshot.running) return { tone: 'working', title: WORKING[snapshot.running.kind] };
  const checked = snapshot.checked;
  if (!checked) return { tone: 'working', title: 'Checking…' };
  if (checked.usesOther) return { tone: 'todo', title: 'Uses an executable not found here' };
  if (!used) return { tone: 'todo', title: 'Not installed' };
  if (used.needsSignIn) return { tone: 'todo', title: 'Not signed in' };
  if (used.signIn?.status === 'signed-out') return { tone: 'todo', title: 'Can’t be used yet' };
  if (used.signIn?.status === 'unknown')
    return { tone: 'todo', title: 'Sign-in could not be checked' };
  if (used.updateAvailable) return { tone: 'offer', title: 'Update available' };
  return { tone: 'done', title: 'Ready' };
}

/** How the person is told of an installation's version against the latest one. */
function versionLine(installation: ProviderSetupInstallation): string | null {
  const { version, latestVersion, updateAvailable } = installation;
  if (!version || !latestVersion) return null;
  if (updateAvailable && installation.can.update)
    return `Can update v${version} to v${latestVersion}.`;
  if (updateAvailable)
    return `v${latestVersion} is out, but this installation of v${version} can’t be updated from here.`;
  if (latestVersion === version) return `v${version} is the latest published version.`;
  return `v${version} is newer than the latest published version, v${latestVersion}.`;
}

/** The menu of the status box: which installation to use, and what to do with it. */
function SetupMenu({
  snapshot,
  used,
  busy,
  onUse,
  onRefresh,
  onRun,
  onUninstall,
  onOtherExecutable,
}: {
  snapshot: ProviderSetupSnapshot;
  used: ProviderSetupInstallation | undefined;
  busy: boolean;
  onUse: (installation: string | null) => void;
  onOtherExecutable: () => void;
  onRefresh: () => void;
  onRun: (operation: ProviderSetupOperation) => void;
  onUninstall: (() => void) | null;
}) {
  const checked = snapshot.checked;
  const installations = checked?.installations ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
        aria-label="Installation options"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {checked && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Use installation</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Sessions on this computer use</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy} onClick={() => onUse(null)}>
                  <span className="flex w-full items-center gap-2">
                    <span className="flex-1">The first on PATH</span>
                    {!checked?.chosen && !checked?.usesOther && <Check className="size-3.5" />}
                  </span>
                </DropdownMenuItem>
                {installations.map((installation) => (
                  <DropdownMenuItem
                    key={installation.id}
                    disabled={busy}
                    onClick={() => onUse(installation.id)}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="flex min-w-0 flex-1 flex-col text-xs">
                        <Rich text={installation.description} />
                      </span>
                      {checked?.chosen && installation.id === checked.used && (
                        <Check className="size-3.5 shrink-0" />
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy} onClick={onOtherExecutable}>
                  Another executable…
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem disabled={busy} onClick={onRefresh}>
          Refresh
        </DropdownMenuItem>
        {used?.can.checkForUpdates && (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => onRun({ kind: 'checkForUpdates', installation: used.id })}
          >
            Check for updates
          </DropdownMenuItem>
        )}
        {used && (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => onRun({ kind: 'verify', installation: used.id })}
          >
            Test connection
          </DropdownMenuItem>
        )}
        {onUninstall && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={busy} onClick={onUninstall}>
              Uninstall
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The steps of `operation`, with the button that has Console take the first
 * (it alone, after which the setup checks again), and how its last run went.
 */
function OperationSteps({
  snapshot,
  operation,
  steps,
  verb,
  onRun,
}: {
  snapshot: ProviderSetupSnapshot;
  operation: ProviderSetupOperation;
  steps: ManualStep[];
  /** The button's word where the first step is the whole of it: "Install". */
  verb: string;
  onRun: (operation: ProviderSetupOperation, authorized: ProviderSetupAuthorization) => void;
}) {
  const first = steps[0];
  const running = sameOperation(snapshot.running, operation);
  return (
    <>
      <SetupSteps
        steps={steps}
        action={
          first && (
            <StepButton
              label={steps.length === 1 ? verb : 'Run'}
              running={running}
              disabled={snapshot.running !== null}
              onClick={() => onRun(operation, [first.id])}
            />
          )
        }
      />
      <FailureNote run={latestRunOf(snapshot, operation)} />
    </>
  );
}

/** Installing, with the way to install it chosen from a menu. */
function InstallBox({
  snapshot,
  onRun,
}: {
  snapshot: ProviderSetupSnapshot;
  onRun: (operation: ProviderSetupOperation, authorized: ProviderSetupAuthorization) => void;
}) {
  const options = snapshot.checked?.installOptions ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const preferred = snapshot.checked?.preferredOption ?? null;
  const option = options.find((each) => each.id === (chosen ?? preferred)) ?? options[0];
  if (!option) return null;
  return (
    <ActionBox>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">Install with {option.title}</p>
        {options.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-background-2 hover:text-foreground">
              Other ways
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {options.map((each, i) => (
                <DropdownMenuItem key={each.id} onClick={() => setChosen(each.id)}>
                  <span className="flex w-full items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>
                        {each.title}
                        {i === 0 && (
                          <span className="ml-1.5 text-xs text-foreground-muted">recommended</span>
                        )}
                      </span>
                      <span className="text-xs text-foreground-muted">
                        <Rich text={each.description} />
                      </span>
                    </span>
                    {each.id === option.id && <Check className="size-3.5 shrink-0" />}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <OperationSteps
        snapshot={snapshot}
        operation={{ kind: 'install', option: option.id }}
        steps={option.steps}
        verb="Install"
        onRun={onRun}
      />
    </ActionBox>
  );
}

/**
 * Signing in: the provider's sign-in command, with the button that runs it
 * here, the sign-in page it printed while it runs, and running it in a
 * terminal as the other way.
 */
function SignInBox({
  snapshot,
  installation,
  provider,
  onRun,
}: {
  snapshot: ProviderSetupSnapshot;
  installation: ProviderSetupInstallation;
  provider: string;
  onRun: (operation: ProviderSetupOperation, authorized: ProviderSetupAuthorization) => void;
}) {
  const operation: ProviderSetupOperation = { kind: 'signIn', installation: installation.id };
  const running = sameOperation(snapshot.running, operation);
  // A sign-in command can print its own local callback address too, which is no page to open.
  const links = running
    ? linksIn(snapshot.runs.at(-1)?.output ?? []).filter(
        (link) => !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(link)
      )
    : [];
  const first = installation.steps.signIn[0];
  return (
    <ActionBox>
      <SetupSteps
        steps={installation.steps.signIn}
        action={
          first &&
          (running ? (
            <StepButton
              label="Cancel"
              running={false}
              disabled={false}
              onClick={() => void rpc.providerSetup.stop(provider)}
            />
          ) : (
            <StepButton
              label="Sign in"
              running={false}
              disabled={snapshot.running !== null}
              onClick={() => onRun(operation, [first.id])}
            />
          ))
        }
      />
      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <Button
              key={link}
              size="sm"
              variant="outline"
              onClick={() => void openExternalUrl(link, 'Could not open the sign-in page')}
            >
              <ExternalLink className="size-3.5" />
              Open sign-in page
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-foreground-muted">
        {running
          ? 'Finish signing in in your browser.'
          : 'Sign in opens your browser. Or run the command yourself in a terminal on this computer, then Refresh.'}
      </p>
      <FailureNote run={latestRunOf(snapshot, operation)} />
    </ActionBox>
  );
}

/** Choosing an executable by its path, wherever it is, for sessions on this computer. */
function ExecutablePathField({
  busy,
  onUse,
  onCancel,
}: {
  busy: boolean;
  onUse: (path: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState('');
  return (
    <form
      className="flex items-center gap-1.5 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (path.trim()) onUse(path.trim());
      }}
    >
      <Input
        autoFocus
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="/path/to/the/executable"
        className="h-7 font-mono text-xs"
      />
      <Button size="sm" type="submit" disabled={busy || !path.trim()}>
        Use
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * A provider's setup on this computer, in one box: how it stands overall, the
 * installation sessions use, its version and sign-in, and what was last done
 * to find out; with what needs doing, if anything, in boxes under it.
 *
 * It all goes by the provider's setup, as Switch Console last checked it:
 * see the provider setup service for what each thing a person does runs.
 */
export function ProviderSetup({ providerId }: { providerId: string }) {
  const snapshot = useProviderSetupSnapshot(providerId);
  const [uninstalling, setUninstalling] = useState(false);
  const [choosingPath, setChoosingPath] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = (promise: Promise<void>) => {
    setError(null);
    promise.catch((e: unknown) => setError(failureText(e, 'The setup could not run.')));
  };
  const run = (operation: ProviderSetupOperation, authorized: ProviderSetupAuthorization) =>
    call(rpc.providerSetup.run(providerId, operation, authorized));

  if (!snapshot) return null;
  const checked = snapshot.checked;
  const used = checked?.installations.find((installation) => installation.id === checked.used);
  const overall = overallOf(snapshot, used);
  const busy = snapshot.running !== null;
  const installedWith = used?.installedVia
    ? checked?.installOptions.find((option) => option.id === used.installedVia)?.title
    : undefined;
  const line = used && versionLine(used);
  // A test of the connection Console could not take itself leaves its steps.
  const lastRun = snapshot.runs.at(-1);
  const testRun =
    lastRun?.operation.kind === 'verify' && lastRun.manual.length > 0 ? lastRun : undefined;

  return (
    <div className="space-y-3" data-testid="provider-setup">
      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex min-h-7 items-center gap-2">
          <StatusIcon tone={overall.tone} />
          <div
            className={cn(
              'min-w-0 flex-1 text-sm',
              overall.tone === 'todo' && 'text-foreground-warning',
              overall.tone === 'offer' && 'text-foreground-info'
            )}
          >
            {overall.title}
          </div>
          <SetupMenu
            snapshot={snapshot}
            used={used}
            busy={busy}
            onUse={(installation) => call(rpc.providerSetup.use(providerId, installation))}
            onRefresh={() => call(rpc.providerSetup.refresh(providerId))}
            onRun={(operation) => run(operation, [])}
            onUninstall={used?.steps.uninstall ? () => setUninstalling(true) : null}
            onOtherExecutable={() => setChoosingPath(true)}
          />
        </div>
        <div className="space-y-1 pl-6">
          {used && (
            <Disclosure
              label={
                [used.version && `v${used.version}`, installedWith && `via ${installedWith}`]
                  .filter(Boolean)
                  .join(' ') || 'Details'
              }
            >
              <p className="break-all">
                <Rich text={used.description} />
              </p>
              <p>
                {checked?.chosen
                  ? 'Chosen for sessions on this computer.'
                  : 'The first on PATH, which sessions on this computer use.'}
              </p>
            </Disclosure>
          )}
          {used?.signIn?.status === 'signed-in' && used.signIn.detail && (
            <p className="text-xs break-all text-foreground-muted">{used.signIn.detail}</p>
          )}
          {used &&
            !used.needsSignIn &&
            used.signIn?.status !== 'signed-in' &&
            used.signIn?.detail && (
              <p className="text-xs break-all text-foreground-muted">{used.signIn.detail}</p>
            )}
          {checked?.usesOther && (
            <p className="text-xs text-foreground-muted">
              Sessions on this computer use an executable chosen by its command, or one no longer
              there. Choose an installation from the menu to use one found here.
            </p>
          )}
          {line && <p className="text-xs text-foreground-muted">{line}</p>}
          {choosingPath && (
            <ExecutablePathField
              busy={busy}
              onUse={(path) => {
                setChoosingPath(false);
                call(rpc.providerSetup.useExecutable(providerId, path));
              }}
              onCancel={() => setChoosingPath(false)}
            />
          )}
          {snapshot.error && (
            <p className="text-xs text-foreground-destructive">{snapshot.error}</p>
          )}
          {error && <p className="text-xs text-foreground-destructive">{error}</p>}
          <RunDetails run={snapshot.runs.at(-1)} />
        </div>
      </div>

      {checked && !used && !checked.usesOther && <InstallBox snapshot={snapshot} onRun={run} />}
      {used?.needsSignIn && (
        <SignInBox snapshot={snapshot} installation={used} provider={providerId} onRun={run} />
      )}
      {used?.updateAvailable && used.steps.update && (
        <ActionBox>
          <OperationSteps
            snapshot={snapshot}
            operation={{ kind: 'update', installation: used.id }}
            steps={used.steps.update}
            verb="Update"
            onRun={run}
          />
        </ActionBox>
      )}
      {testRun && (
        <ActionBox>
          <p className="text-sm">Test the connection yourself</p>
          <SetupSteps steps={testRun.manual} action={null} />
        </ActionBox>
      )}
      {uninstalling && used?.steps.uninstall && (
        <ActionBox>
          <div className="flex items-center justify-between">
            <p className="text-sm">Uninstall</p>
            <button
              type="button"
              className="text-xs text-foreground-muted hover:text-foreground"
              onClick={() => setUninstalling(false)}
            >
              Keep it
            </button>
          </div>
          <OperationSteps
            snapshot={snapshot}
            operation={{ kind: 'uninstall', installation: used.id }}
            steps={used.steps.uninstall}
            verb="Uninstall"
            onRun={run}
          />
        </ActionBox>
      )}
    </div>
  );
}
