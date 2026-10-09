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
import { useSwitchCloud } from '@renderer/features/switch-servers/use-switch-cloud';
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
import { CreateWorkspacePage } from './create-workspace-page';
import { AcceptInvitePage, InvitePage } from './invite-pages';
import { onboardingStore, type OnboardingPage } from './onboarding-store';
import { PickWorkspacePage } from './pick-workspace-page';
import { WelcomePage, type WelcomeCloud } from './welcome-page';

/**
 * The first-run pages and the add-server wizard's steps, named against each
 * other so both funnels answer the same question.
 *
 * They are the same steps — the first-run pages are the wizard drawn full
 * window — so reporting them under new names would split "how far did people
 * get" in two. `firstRun` on the event is what keeps them apart where it
 * matters. The welcome page belongs to neither: nothing has been chosen on it
 * and there is no server being added yet.
 *
 * The workspace pages are unreported for the opposite reason: they are not
 * steps of the add-server wizard at all — the modal has nothing like them,
 * because by the time you open it you are already in a workspace — so counting
 * them here would put drop-offs from one funnel into the other's numbers.
 */
const STEP_FOR_PAGE: Record<OnboardingPage, AddServerStepName | null> = {
  welcome: null,
  invite: null,
  whoRuns: 'choose',
  local: 'local',
  remoteHost: 'remoteHost',
  connect: 'external',
  signIn: 'signIn',
  pickWorkspace: null,
  createWorkspace: null,
  acceptInvite: null,
  linkAccounts: 'linkAccounts',
};

/**
 * Which path each page belongs to.
 *
 * Unlike the modal's, these barely inherit: the only way to reach sign-in on a
 * fresh install is by connecting to a server someone else runs. Whether that
 * server was typed in or was Switch Cloud is the one thing the table cannot
 * know, so `choiceForPage` refines it.
 */
const CHOICE_FOR_PAGE: Record<OnboardingPage, AddServerChoiceName> = {
  welcome: 'none',
  invite: 'none',
  whoRuns: 'none',
  local: 'local',
  remoteHost: 'remoteHost',
  connect: 'external',
  signIn: 'external',
  pickWorkspace: 'external',
  createWorkspace: 'external',
  acceptInvite: 'external',
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
  const exit =
    server !== null
      ? { label: 'Finish later', onExit: () => finish(server.id) }
      : onboardingStore.rehearsal
        ? { label: 'Back to the app', onExit: () => finish(null) }
        : null;

  const cloud = useSwitchCloud();
  const [cloudAttempt, setCloudAttempt] = useState<{ connecting: boolean; error: string | null }>({
    connecting: false,
    error: null,
  });

  /**
   * Register Switch Cloud and go straight to signing in to it.
   *
   * There is nothing to ask first: the address is the build's, and the name is
   * the Cloud's. The connect page's form would be a page of fields already
   * filled in.
   */
  const connectToCloud = () => {
    setCloudAttempt({ connecting: true, error: null });
    switchServersStore.connectToSwitchCloud().then(
      (added) => {
        setCloudAttempt({ connecting: false, error: null });
        onboardingStore.connected(added, 'cloud');
        reportPage('signIn');
      },
      (cause) => {
        const failure = describeFailure(cause, 'Could not connect to Switch Cloud.');
        setCloudAttempt({
          connecting: false,
          error: failure.detail ? `${failure.headline} ${failure.detail}` : failure.headline,
        });
      }
    );
  };

  const welcomeCloud: WelcomeCloud =
    cloud.kind === 'open' ? { ...cloud, ...cloudAttempt, onConnect: connectToCloud } : cloud;

  return (
    <WizardChromeProvider chrome="page" exit={exit}>
      {currentPage(server, welcomeCloud, goTo, finish)}
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

function choiceForPage(page: OnboardingPage): AddServerChoiceName {
  const choice = CHOICE_FOR_PAGE[page];
  if (choice === 'external' && page !== 'connect' && onboardingStore.via === 'cloud')
    return 'cloud';
  return choice;
}

function reportPage(page: OnboardingPage): void {
  const step = STEP_FOR_PAGE[page];
  if (step === null) return;
  report('add_server_step', { step, choice: choiceForPage(page), first_run: true });
}

function currentPage(
  server: SwitchServer | null,
  welcomeCloud: WelcomeCloud,
  goTo: (page: OnboardingPage) => void,
  finish: (serverId: string | null) => void
) {
  switch (onboardingStore.page) {
    case 'welcome':
      return (
        <WelcomePage
          cloud={welcomeCloud}
          onContinue={() => goTo('whoRuns')}
          onInvite={() => goTo('invite')}
          onLeave={onboardingStore.rehearsal ? () => finish(null) : null}
        />
      );
    case 'invite':
      return (
        <InvitePage
          onBack={() => goTo('welcome')}
          onResolved={(invite, found) => {
            onboardingStore.holdInvite(invite);
            if (found.kind === 'known') {
              onboardingStore.connected(found.server, found.via);
              reportPage('signIn');
            } else {
              goTo('connect');
            }
          }}
        />
      );
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
          // The Cloud was chosen on the welcome page, with no form in between
          // to go back to. An invite link names its server, so the page it was
          // pasted on is where a different one is chosen.
          onBack={() =>
            goTo(
              onboardingStore.invite !== null
                ? 'invite'
                : onboardingStore.via === 'cloud'
                  ? 'welcome'
                  : 'connect'
            )
          }
          onClose={null}
          onSignedIn={() =>
            goTo(onboardingStore.invite !== null ? 'acceptInvite' : 'pickWorkspace')
          }
        />
      );
    case 'pickWorkspace':
      if (server === null) break;
      return (
        <PickWorkspacePage
          server={server}
          onBack={() => goTo('signIn')}
          onPicked={() => goTo('linkAccounts')}
          onCreate={() => goTo('createWorkspace')}
        />
      );
    case 'createWorkspace':
      if (server === null) break;
      return (
        <CreateWorkspacePage
          server={server}
          // Nothing to go back to when the account is in no workspace and has
          // no invitation: the picker sent the user straight here, and
          // returning to it would be a door onto a list with nothing in it.
          onBack={onboardingStore.pickerHasChoices ? () => goTo('pickWorkspace') : null}
          onCreated={() => goTo('linkAccounts')}
        />
      );
    case 'acceptInvite': {
      const invite = onboardingStore.invite;
      if (server === null || invite === null) break;
      return (
        <AcceptInvitePage
          server={server}
          invite={invite}
          onAccepted={() => {
            onboardingStore.dropInvite();
            goTo('linkAccounts');
          }}
          onSkip={() => {
            onboardingStore.dropInvite();
            goTo('pickWorkspace');
          }}
        />
      );
    }
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

  // An invite link for a server this install does not know gives the address
  // its dashboard is on, which on a current server is the server's own. It stays
  // editable, and saving it catches an older server's separate dashboard.
  const inviteOrigin = onboardingStore.invite?.origin ?? null;
  return (
    <ExternalServerStep
      initialUrl={inviteOrigin}
      dashboardHint={inviteOrigin}
      initialName={null}
      serverId={null}
      isEdit={false}
      firstRun
      existing={server}
      onBack={() => goTo(inviteOrigin === null ? 'whoRuns' : 'invite')}
      onClose={() => goTo(inviteOrigin === null ? 'whoRuns' : 'invite')}
      onSuccess={() => finish(server?.id ?? null)}
      onConnected={(added) => {
        onboardingStore.connected(added, 'external');
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
            description="Connect to a Switch server your team or someone else operates. You'll need its address."
            onClick={onExternal}
          />
        </div>
      )}
    </WizardFrame>
  );
}
