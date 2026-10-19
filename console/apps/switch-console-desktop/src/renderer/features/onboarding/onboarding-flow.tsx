import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { buddyIntroStore } from '@renderer/features/switch-buddy/buddy-intro-store';
import { BuddyStep } from '@renderer/features/switch-buddy/buddy-step';
import { openBuddyChat } from '@renderer/features/switch-buddy/open-buddy';
import {
  ExternalServerStep,
  LocalSetupStep,
  SignInStep,
} from '@renderer/features/switch-servers/AddServerModal';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useSwitchCloud } from '@renderer/features/switch-servers/use-switch-cloud';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { report } from '@renderer/lib/telemetry/report';
import { WizardChromeProvider } from '@renderer/lib/ui/wizard-frame';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';
import { CreateWorkspacePage } from './create-workspace-page';
import { type CloudChoiceState, HowToRunPage } from './how-to-run-page';
import { OnboardingIntro } from './onboarding-intro';
import { onboardingStore, type OnboardingPage } from './onboarding-store';
import { PickWorkspacePage } from './pick-workspace-page';
import { WelcomePage } from './welcome-page';

/**
 * The first-run pages and the add-server wizard's steps, named against each
 * other so both funnels answer the same question.
 *
 * The pages that set a server up are the wizard's own steps drawn full window,
 * so reporting them under new names would split "how far did people get" in
 * two. `firstRun` on the event is what keeps them apart where it matters. The
 * welcome, workspace and buddy pages belong to no step of the wizard and are
 * not reported here.
 */
const STEP_FOR_PAGE: Record<OnboardingPage, AddServerStepName | null> = {
  welcome: null,
  howToRun: 'choose',
  local: 'local',
  connect: 'external',
  signIn: 'signIn',
  pickWorkspace: null,
  createWorkspace: null,
  meetBuddy: null,
};

/**
 * Which path each page belongs to. Whether a server signed in to was typed in,
 * was Switch Cloud or was started here is the one thing the table cannot know,
 * so `choiceForPage` refines it.
 */
const CHOICE_FOR_PAGE: Record<OnboardingPage, AddServerChoiceName> = {
  welcome: 'none',
  howToRun: 'none',
  local: 'local',
  connect: 'external',
  signIn: 'external',
  pickWorkspace: 'external',
  createWorkspace: 'external',
  meetBuddy: 'external',
};

/**
 * Everything the window shows before there is a workspace to show: what
 * Switch is, where it runs, signing in, the workspace, and meeting
 * switch-buddy, the first agent, which the flow ends in a chat with.
 *
 * The pages that set the server up are the add-server wizard's own steps,
 * drawn full window instead of in a dialog, so the Docker check, the
 * connection form and the sign-in cannot drift from what the rest of the app
 * does.
 */
/** Each page as the first-run funnel names it. */
const FUNNEL_PAGE: Record<OnboardingPage, RendererTelemetryEvents['onboarding_page']['page']> = {
  welcome: 'welcome',
  howToRun: 'how_to_run',
  local: 'local_setup',
  connect: 'server_address',
  signIn: 'sign_in',
  pickWorkspace: 'choose_workspace',
  createWorkspace: 'create_workspace',
  meetBuddy: 'meet_buddy',
};

/** How the install runs Switch, once the page on screen says. */
function funnelPath(page: OnboardingPage): RendererTelemetryEvents['onboarding_page']['path'] {
  if (page === 'welcome' || page === 'howToRun') return 'none';
  if (page === 'local') return 'local';
  if (page === 'connect') return 'external';
  return onboardingStore.via;
}

export const OnboardingFlow = observer(function OnboardingFlow() {
  const { navigate } = useNavigate();
  const page = onboardingStore.page;
  // switch-buddy runs on this computer at the end, whatever server is chosen:
  // its providers are checked now, while the person signs in, so the buddy's
  // page knows what is signed in by the time it opens.
  useEffect(() => {
    void rpc.embeddedController.precheckProviders();
  }, []);
  // Every page as it opens, so the last one an install reports is where it
  // stopped.
  useEffect(() => {
    // The workspace picker says so itself: it often moves straight on, and a
    // page the person never saw must not count as reached.
    if (page === 'pickWorkspace') return;
    report('onboarding_page', { page: FUNNEL_PAGE[page], path: funnelPath(page) });
  }, [page]);

  const goTo = (page: OnboardingPage) => {
    onboardingStore.goTo(page);
    reportPage(page);
  };

  /** Leave the first-run pages for the app, on the server they set up. */
  const finish = (serverId: string | null) => {
    onboardingStore.reset();
    if (serverId === null) return;
    void switchServersStore.setActive(serverId);
    navigate('server', { serverId });
  };

  /** Leave them for the buddy's chat: its own once it exists, else the one waiting for a provider. */
  const finishWithBuddy = async (
    serverId: string,
    agent: { agentId: string; name: string } | null
  ) => {
    // The destination is chosen, and its chat found or made, while the flow
    // is still on screen: ending the flow first would draw the app's home
    // page for the moment that takes, then jump to the buddy.
    await switchServersStore.setActive(serverId);
    if (agent) await openBuddyChat(serverId, agent);
    else {
      buddyIntroStore.skipped();
      navigate('switchBuddy', { serverId });
    }
    onboardingStore.reset();
  };

  // The server as the list has it, not as the flow remembers it: it can be
  // deleted from under the flow once the window is the workspace again for a
  // view that does not need one.
  const server = switchServersStore.serverById(pageServerId());

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

  /** Register Switch Cloud and go straight to signing in to it: there is nothing to ask first. */
  const connectToCloud = () => {
    setCloudAttempt({ connecting: true, error: null });
    switchServersStore.connectToSwitchCloud().then(
      (added) => {
        setCloudAttempt({ connecting: false, error: null });
        connectedTo(added, 'cloud');
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

  const cloudChoice: CloudChoiceState =
    cloud.kind === 'open' ? { ...cloud, ...cloudAttempt, onConnect: connectToCloud } : cloud;

  return (
    <WizardChromeProvider chrome="page" exit={exit}>
      {/* Keyed by page, so each one opens afresh, with its entrance. */}
      <Fragment key={page}>
        {currentPage(server, cloudChoice, goTo, finish, finishWithBuddy)}
      </Fragment>
    </WizardChromeProvider>
  );
});

/**
 * The server the page on screen is the setup of, if it has one yet: the one a
 * managed path brought up, while its page is on screen, or the one signed in
 * to on the pages after.
 */
function pageServerId(): string | null {
  const page = onboardingStore.page;
  if (onboardingStore.registeredOn?.page === page) return onboardingStore.registeredOn.serverId;
  if (CHOICE_FOR_PAGE[page] !== 'external') return null;
  return onboardingStore.server?.id ?? null;
}

/**
 * A server was added or found: sign in to it, unless this Console is signed in
 * already — replaying these pages against a server it knows — when the
 * workspace is next.
 */
function connectedTo(server: SwitchServer, via: 'external' | 'cloud'): void {
  onboardingStore.connected(server, via);
  if (switchServersStore.isConnected(server.id)) {
    onboardingStore.goTo('pickWorkspace');
    return;
  }
  reportPage('signIn');
}

function choiceForPage(page: OnboardingPage): AddServerChoiceName {
  const choice = CHOICE_FOR_PAGE[page];
  if (choice === 'external' && page !== 'connect' && onboardingStore.via !== 'external')
    return onboardingStore.via;
  return choice;
}

function reportPage(page: OnboardingPage): void {
  const step = STEP_FOR_PAGE[page];
  if (step === null) return;
  report('add_server_step', { step, choice: choiceForPage(page), first_run: true });
}

function currentPage(
  server: SwitchServer | null,
  cloud: CloudChoiceState,
  goTo: (page: OnboardingPage) => void,
  finish: (serverId: string | null) => void,
  finishWithBuddy: (
    serverId: string,
    agent: { agentId: string; name: string } | null
  ) => Promise<void>
) {
  switch (onboardingStore.page) {
    case 'welcome':
      if (onboardingStore.introPending)
        return <OnboardingIntro onDone={() => onboardingStore.introPlayed()} />;
      return (
        <WelcomePage
          onContinue={() => goTo('howToRun')}
          onLeave={onboardingStore.rehearsal ? () => finish(null) : null}
        />
      );
    case 'howToRun':
      return (
        <HowToRunPage
          cloud={cloud}
          onBack={() => goTo('welcome')}
          onLocal={() => goTo('local')}
          onExternal={() => goTo('connect')}
        />
      );
    case 'local':
      return (
        <LocalSetupStep
          onBack={() => goTo('howToRun')}
          onDone={(serverId) => {
            // Console signed in to the stack it runs as its admin: the
            // workspace is next, not a sign-in page.
            const started = serverId === null ? null : switchServersStore.serverById(serverId);
            if (started) onboardingStore.startedLocally(started);
            else finish(serverId);
          }}
          onClose={null}
          onRegistered={(serverId) => onboardingStore.registered('local', serverId)}
        />
      );
    case 'signIn':
      // Needs the server the previous page added; without one the flow goes
      // back to the page that makes it rather than drawing a form against nothing.
      if (server === null) break;
      return (
        <SignInStep
          server={server}
          onBack={() => goTo(onboardingStore.via === 'cloud' ? 'howToRun' : 'connect')}
          onClose={null}
          onSignedIn={() => goTo('pickWorkspace')}
        />
      );
    case 'pickWorkspace':
      if (server === null) break;
      return (
        <PickWorkspacePage
          server={server}
          onBack={() => goTo(onboardingStore.via === 'local' ? 'howToRun' : 'signIn')}
          onPicked={() => goTo('meetBuddy')}
          onCreate={() => goTo('createWorkspace')}
        />
      );
    case 'createWorkspace':
      if (server === null) break;
      return (
        <CreateWorkspacePage
          server={server}
          // Nothing to go back to when the account is in no workspace and has
          // no invitation: the picker sent the user straight here.
          onBack={onboardingStore.pickerHasChoices ? () => goTo('pickWorkspace') : null}
          onCreated={() => goTo('meetBuddy')}
        />
      );
    case 'meetBuddy': {
      if (server === null) break;
      const workspaceId = workspacesStore.idOnServerInScope(server.id);
      // The buddy belongs to a workspace; with none open there is one to choose first.
      if (workspaceId === null)
        return (
          <PickWorkspacePage
            server={server}
            onBack={() => goTo('signIn')}
            onPicked={() => goTo('meetBuddy')}
            onCreate={() => goTo('createWorkspace')}
          />
        );
      return (
        <BuddyStep
          serverId={server.id}
          workspaceId={workspaceId}
          onCreated={(agent) => void finishWithBuddy(server.id, agent)}
          onSkip={() => void finishWithBuddy(server.id, null)}
          onNotOffered={() => finish(server.id)}
        />
      );
    }
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
      onBack={() => goTo('howToRun')}
      onClose={() => goTo('howToRun')}
      onSuccess={() => finish(server?.id ?? null)}
      onConnected={(added) => connectedTo(added, 'external')}
    />
  );
}
