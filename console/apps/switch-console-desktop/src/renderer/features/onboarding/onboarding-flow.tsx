import { Link2, Server, TriangleAlert, Wrench } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import {
  ChoiceCard,
  ExternalServerStep,
  LocalSetupStep,
  RemoteHostSetupStep,
  SignInStep,
} from '@renderer/features/switch-servers/AddServerModal';
import { LinkAccountsStep } from '@renderer/features/switch-servers/link-accounts-step';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { report } from '@renderer/lib/telemetry/report';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardChromeProvider, WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { onboardingStore, type OnboardingPage } from './onboarding-store';
import { WelcomePage } from './welcome-page';

/**
 * The first-run pages and the add-server wizard's steps, named against each
 * other so both funnels answer the same question.
 *
 * They are the same steps — the first-run pages are the wizard drawn full
 * window — so reporting them under new names would split "how far did people
 * get" in two. `firstRun` on the event is what keeps them apart where it
 * matters. The welcome page belongs to neither: nothing has been chosen on it
 * and there is no server being added yet.
 */
const STEP_FOR_PAGE: Record<OnboardingPage, AddServerStepName | null> = {
  welcome: null,
  whoRuns: 'choose',
  local: 'local',
  remoteHost: 'remoteHost',
  connect: 'external',
  signIn: 'signIn',
  linkAccounts: 'linkAccounts',
};

/**
 * Which path each page belongs to.
 *
 * Unlike the modal's, none of these inherit: the only way to reach sign-in on a
 * fresh install is by connecting to a server someone else runs.
 */
const CHOICE_FOR_PAGE: Record<OnboardingPage, AddServerChoiceName> = {
  welcome: 'none',
  whoRuns: 'none',
  local: 'local',
  remoteHost: 'remoteHost',
  connect: 'external',
  signIn: 'external',
  linkAccounts: 'external',
};

/**
 * Everything the window shows before there is a server to show.
 *
 * The pages after the first are the add-server wizard's own steps, drawn full
 * window instead of in a dialog. Setting up a server is the same three
 * questions whether you have none or nine, and a first-run copy of them would
 * be a second place for the Docker check, the connection form and the sign-in
 * to drift from what the rest of the app does.
 *
 * Running a managed stack on a remote host is offered only when there is a host
 * to run it on. It needs one onboarded over SSH, which a fresh install has none
 * of — but onboarding a host needs no server, so someone who deleted their last
 * one may well arrive here with hosts already set up, and hiding the path from
 * them would leave it unreachable.
 */
export const OnboardingFlow = observer(function OnboardingFlow() {
  const { navigate } = useNavigate();

  const goTo = (page: OnboardingPage) => {
    onboardingStore.goTo(page);
    reportPage(page);
  };

  /**
   * Leave the first-run pages for the app they were setting up.
   *
   * Landing on the new server's page rather than wherever the window would
   * otherwise open: the flow was about that server, and dropping the user into
   * an empty home view would make the last ten minutes look like they did
   * nothing.
   */
  const finish = (serverId: string | null) => {
    onboardingStore.reset();
    if (serverId === null) return;
    void switchServersStore.setActive(serverId);
    navigate('server', { serverId });
  };

  // The server as the list has it, not as the flow remembers it. Once one
  // exists the window is the workspace again for any view that does not need a
  // server, so it can be deleted from under the flow — and a form aimed at a
  // row that is gone fails on submit with no way back to a working one.
  const server = switchServersStore.serverById(pageServerId());

  /**
   * Leave the flow for the app, with the server set up but the rest not done.
   *
   * Offered only once the page on screen has a server of its own, which is both
   * when there is something to come back to and when the flow stops being the
   * only thing the window can draw. Before that, stepping back off the welcome
   * page is the way out.
   */
  const exit = server === null ? null : { label: 'Finish later', onExit: () => finish(server.id) };

  return (
    <WizardChromeProvider chrome="page" exit={exit}>
      {currentPage(server, goTo, finish)}
    </WizardChromeProvider>
  );
});

/**
 * The server the page on screen is the setup of, if it has one yet.
 *
 * Asked per page rather than kept as one field, because the paths reach a
 * server by different means and none of them owns another's: the connect page
 * hands one over and every page after it works on that same one, while each
 * managed page brings its own up. Reading a single field instead offered a way
 * out to a server the current page had nothing to do with — connect to one,
 * walk back, choose the local path, and the exit still pointed at the first.
 */
function pageServerId(): string | null {
  const page = onboardingStore.page;
  if (onboardingStore.registeredOn?.page === page) return onboardingStore.registeredOn.serverId;
  if (CHOICE_FOR_PAGE[page] !== 'external') return null;
  return onboardingStore.server?.id ?? null;
}

function reportPage(page: OnboardingPage): void {
  const step = STEP_FOR_PAGE[page];
  if (step === null) return;
  report('add_server_step', { step, choice: CHOICE_FOR_PAGE[page], first_run: true });
}

function currentPage(
  server: SwitchServer | null,
  goTo: (page: OnboardingPage) => void,
  finish: (serverId: string | null) => void
) {
  switch (onboardingStore.page) {
    case 'welcome':
      return <WelcomePage onContinue={() => goTo('whoRuns')} />;
    case 'whoRuns':
      return (
        <WhoRunsPage
          onBack={() => goTo('welcome')}
          onLocal={() => goTo('local')}
          onRemoteHost={() => goTo('remoteHost')}
          onExternal={() => goTo('connect')}
        />
      );
    case 'local':
      return (
        <LocalSetupStep
          onBack={() => goTo('whoRuns')}
          onDone={finish}
          onClose={null}
          onRegistered={(serverId) => onboardingStore.registered('local', serverId)}
        />
      );
    case 'remoteHost':
      return (
        <RemoteHostSetupStep
          onBack={() => goTo('whoRuns')}
          onDone={finish}
          onClose={() => goTo('whoRuns')}
          onRegistered={(serverId) => onboardingStore.registered('remoteHost', serverId)}
        />
      );
    case 'signIn':
      // Both of these need the server the connect page added. Without one there
      // is nothing to sign in to, so the flow goes back to the page that makes
      // it rather than drawing a form against nothing.
      if (server === null) break;
      return (
        <SignInStep
          server={server}
          onBack={() => goTo('connect')}
          onClose={null}
          onSignedIn={() => goTo('linkAccounts')}
        />
      );
    case 'linkAccounts':
      if (server === null) break;
      return (
        <LinkAccountsStep
          serverId={server.id}
          serverName={server.name}
          onDone={() => finish(server.id)}
        />
      );
    case 'connect':
      break;
  }

  return (
    <ExternalServerStep
      initialGatewayUrl={null}
      initialApiUrl={null}
      initialName={null}
      serverId={null}
      isEdit={false}
      firstRun
      existing={server}
      onBack={() => goTo('whoRuns')}
      onClose={() => goTo('whoRuns')}
      onSuccess={() => finish(server?.id ?? null)}
      onConnected={(added) => {
        onboardingStore.connected(added);
        reportPage('signIn');
      }}
    />
  );
}

/**
 * Whether there are onboarded hosts to offer the managed path on.
 *
 * Three states, not two. A failed read is not an empty list — saying "no hosts"
 * because the question could not be asked hides a path the user has already set
 * up and leaves them no way to tell why.
 */
type HostsRead =
  | { kind: 'reading' }
  | { kind: 'read'; hosts: { sshHost: string }[] }
  | { kind: 'failed'; headline: string; detail: string | null };

function WhoRunsPage({
  onBack,
  onLocal,
  onRemoteHost,
  onExternal,
}: {
  onBack: () => void;
  onLocal: () => void;
  onRemoteHost: () => void;
  onExternal: () => void;
}) {
  const [hosts, setHosts] = useState<HostsRead>({ kind: 'reading' });

  const readHosts = useCallback(() => {
    setHosts({ kind: 'reading' });
    void rpc.remoteHosts.listHosts().then(
      (list) => setHosts({ kind: 'read', hosts: list }),
      (cause) =>
        setHosts({
          kind: 'failed',
          ...describeFailure(cause, 'Could not check for onboarded hosts.'),
        })
    );
  }, []);

  useEffect(readHosts, [readHosts]);

  return (
    <WizardFrame
      title="Who runs the server?"
      subtitle="Either Switch Console installs and looks after the stack for you, or you point it at one that already exists."
      /* The chevron below repeats this. It is unlabelled, so it cannot be the
         only way back from a page whose cards all lead forward. */
      footer={
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      }
      pager={{ pageName: 'Who runs the server', onBack, onNext: null }}
    >
      {/* The whole set waits on the read, not just the card it decides. Painting
          two and inserting a third between them a round trip later moves the
          answer under a cursor already on its way to one. */}
      {hosts.kind === 'reading' ? (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          <span>Looking for onboarded hosts…</span>
        </div>
      ) : (
        <div className="grid gap-3">
          {hosts.kind === 'failed' && (
            // The two certain paths are still offered: not knowing about hosts
            // is no reason to hold the whole question hostage. Retrying may add
            // a third card, but only because it was asked for.
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>{hosts.headline}</AlertTitle>
              <AlertDescription>
                {hosts.detail ? `${hosts.detail} ` : ''}
                Running a server on one of your own hosts is not offered until this succeeds.
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={readHosts}>
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          )}
          <ChoiceCard
            icon={<Wrench className="size-5" />}
            title="Set it up for me"
            description="Switch Console installs the full stack on this computer with Docker and keeps it updated."
            onClick={onLocal}
          />
          {hosts.kind === 'read' && hosts.hosts.length > 0 && (
            <ChoiceCard
              icon={<Server className="size-5" />}
              title="Set it up on one of my hosts"
              description="Switch Console installs the stack over SSH on a host you've onboarded. Stays running when Switch Console is closed."
              onClick={onRemoteHost}
            />
          )}
          <ChoiceCard
            icon={<Link2 className="size-5" />}
            title="It's already running"
            description="Connect by URL to a Switch gateway your team or someone else operates. You'll need its gateway and API addresses."
            onClick={onExternal}
          />
        </div>
      )}
    </WizardFrame>
  );
}
