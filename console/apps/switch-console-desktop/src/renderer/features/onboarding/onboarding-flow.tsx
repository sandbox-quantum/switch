import { Link2, Wrench } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  ChoiceCard,
  ExternalServerStep,
  LocalSetupStep,
  SignInStep,
} from '@renderer/features/switch-servers/AddServerModal';
import { LinkAccountsStep } from '@renderer/features/switch-servers/link-accounts-step';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { report } from '@renderer/lib/telemetry/report';
import { WizardChromeProvider, WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import { CreateWorkspacePage } from './create-workspace-page';
import { onboardingStore, type OnboardingPage } from './onboarding-store';
import { PickWorkspacePage } from './pick-workspace-page';
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
 *
 * The workspace pages are unreported for the opposite reason: they are not
 * steps of the add-server wizard at all — the modal has nothing like them,
 * because by the time you open it you are already in a workspace — so counting
 * them here would put drop-offs from one funnel into the other's numbers.
 */
const STEP_FOR_PAGE: Record<OnboardingPage, AddServerStepName | null> = {
  welcome: null,
  whoRuns: 'choose',
  local: 'local',
  connect: 'external',
  signIn: 'signIn',
  pickWorkspace: null,
  createWorkspace: null,
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
  connect: 'external',
  signIn: 'external',
  pickWorkspace: 'external',
  createWorkspace: 'external',
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
 * Running a managed stack on a remote host is the one path the wizard offers
 * and this does not. It needs a host you have already onboarded over SSH, and a
 * fresh install has none — the card would lead to an empty list every time.
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

  return <WizardChromeProvider chrome="page">{currentPage(goTo, finish)}</WizardChromeProvider>;
});

function reportPage(page: OnboardingPage): void {
  const step = STEP_FOR_PAGE[page];
  if (step === null) return;
  report('add_server_step', { step, choice: CHOICE_FOR_PAGE[page], first_run: true });
}

function currentPage(
  goTo: (page: OnboardingPage) => void,
  finish: (serverId: string | null) => void
) {
  const server = onboardingStore.server;

  switch (onboardingStore.page) {
    case 'welcome':
      return <WelcomePage onContinue={() => goTo('whoRuns')} />;
    case 'whoRuns':
      return (
        <WhoRunsPage
          onBack={() => goTo('welcome')}
          onLocal={() => goTo('local')}
          onExternal={() => goTo('connect')}
        />
      );
    case 'local':
      return <LocalSetupStep onBack={() => goTo('whoRuns')} onDone={finish} onClose={null} />;
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
          onSignedIn={() => goTo('pickWorkspace')}
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
          // Nothing to go back to when the account is in no workspace: the
          // picker sent the user straight here, and returning to it would be a
          // door onto the list it had nothing to show.
          onBack={onboardingStore.serverWorkspaces?.length ? () => goTo('pickWorkspace') : null}
          onCreated={() => goTo('linkAccounts')}
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

function WhoRunsPage({
  onBack,
  onLocal,
  onExternal,
}: {
  onBack: () => void;
  onLocal: () => void;
  onExternal: () => void;
}) {
  return (
    <WizardFrame
      title="Who runs the server?"
      subtitle="Either Switch Console installs and looks after the stack for you, or you point it at one that already exists."
      footer={null}
      pager={{ pageName: 'Who runs the server', onBack, onNext: null }}
    >
      <div className="grid gap-3">
        <ChoiceCard
          icon={<Wrench className="size-5" />}
          title="Set it up for me"
          description="Switch Console installs the full stack on this computer with Docker and keeps it updated."
          onClick={onLocal}
        />
        <ChoiceCard
          icon={<Link2 className="size-5" />}
          title="It's already running"
          description="Connect by URL to a Switch gateway your team or someone else operates. You'll need its gateway and API addresses."
          onClick={onExternal}
        />
      </div>
    </WizardFrame>
  );
}
