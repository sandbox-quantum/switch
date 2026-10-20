import { makeAutoObservable } from 'mobx';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';

/** Where a fresh install is in getting its first server. */
export type OnboardingPage =
  | 'welcome'
  | 'howToRun'
  | 'local'
  | 'connect'
  | 'signIn'
  | 'pickWorkspace'
  | 'createWorkspace'
  | 'meetBuddy';

/**
 * The first-run flow's place in itself.
 *
 * Held in a store rather than in the page that draws it, because the flow
 * outlives its own component. The shell takes the window away from it whenever
 * Settings is opened, and it decides between the first-run pages and the
 * workspace from the server list — which stops being empty halfway through the
 * flow, the moment the server is added but several pages before the user has
 * signed in to it. Without somewhere to say "still going", adding the server
 * would throw the user out of the flow that added it.
 *
 * Only the page and the server survive being unmounted. What is half typed into
 * a form does not: the fields belong to the page drawing them, so a stray ⌘,
 * on the connect page costs the two addresses.
 */
/** Where this install remembers the first-run intro has played. */
const INTRO_PLAYED_KEY = 'onboarding.introPlayed';

class OnboardingStore {
  page: OnboardingPage = 'welcome';
  /** The server the connect page added, and the subject of the pages after it. */
  server: SwitchServer | null = null;
  /**
   * How that server was reached: typed in on the connect page, chosen as
   * Switch Cloud, or started on this computer. Decides where Back from
   * sign-in goes and which path the pages after it are reported under.
   */
  via: 'external' | 'cloud' | 'local' = 'external';
  /** The workspaces that server said the account is in, once it has been asked. */
  serverWorkspaces: Workspace[] | null = null;
  /**
   * How many other ways in that server listed alongside: invitations to the
   * account's address, and workspaces open to its domain.
   */
  joinOfferCount = 0;
  /**
   * The server a managed path brought up, and the page that brought it up.
   *
   * The page is kept with it because the two managed paths do not share one:
   * starting a stack on a host and then walking back to pick the local one
   * leaves a server that the page now on screen did not make, and an exit
   * offered to it would take the user somewhere they did not set up.
   */
  registeredOn: { page: OnboardingPage; serverId: string } | null = null;
  /**
   * The server was already signed in to when it was reached, so the flow went
   * from it straight to the workspace: Back from there returns to the page
   * that reached it, not to a sign-in form it never showed.
   */
  signInSkipped = false;
  /**
   * The user has gone past the welcome page since the flow last started.
   *
   * Walking back to it does not undo that: the server list may hold the server
   * the attempt registered by then, and a welcome page that no longer counted
   * as in progress would hand the window to the workspace — Back would leave
   * the flow rather than walk it.
   */
  begun = false;
  /**
   * The flow was opened on purpose from a dev or canary build that already has
   * servers, to walk through the first-run pages again. It keeps the flow on
   * screen from its welcome page, which a launch with servers would otherwise
   * skip, and offers a way back to the app from every page.
   */
  rehearsal = false;
  /**
   * Whether this install has ever played the intro, here or over the app. Unlike
   * `introPending`, a rehearsal does not take it back: an install onboarded
   * before the intro existed is offered it once over the app on this alone.
   */
  introSeen = localStorage.getItem(INTRO_PLAYED_KEY) !== null;
  /**
   * The intro still to play before Welcome: on the first run of this install,
   * and again when the pages are rehearsed.
   */
  introPending = !this.introSeen;

  constructor() {
    makeAutoObservable(this);
  }

  /**
   * Whether the user has committed to setting a server up.
   *
   * The welcome page is not in progress when the flow opens on it: it asks a
   * question and nothing has been started, so a launch that finds servers
   * should go straight past it. Walked back to, it still is.
   */
  get inProgress(): boolean {
    return this.rehearsal || this.begun || this.page !== 'welcome';
  }

  /**
   * The page Back leads to from the one on screen, or null where there is
   * none: the welcome page starts the flow, Meet switch-buddy is past the
   * point of going back, and the create page has nothing behind it when the
   * picker sent the user straight there.
   */
  get previousPage(): OnboardingPage | null {
    switch (this.page) {
      case 'welcome':
        return null;
      case 'howToRun':
        return 'welcome';
      case 'local':
      case 'connect':
        return 'howToRun';
      case 'signIn':
        return this.pageBeforeSignIn;
      case 'pickWorkspace':
      case 'meetBuddy':
        // Meet switch-buddy draws the picker when no workspace is open, and
        // goes back the way the picker does; once the buddy itself is on
        // screen its page offers no Back into the flow.
        if (this.via === 'local') return 'howToRun';
        return this.signInSkipped ? this.pageBeforeSignIn : 'signIn';
      case 'createWorkspace':
        return this.pickerHasChoices ? 'pickWorkspace' : null;
    }
  }

  /** The page that reached the server signed in to: the question for Switch Cloud, the address form otherwise. */
  private get pageBeforeSignIn(): OnboardingPage {
    return this.via === 'cloud' ? 'howToRun' : 'connect';
  }

  /** Open the first-run pages from their start, whatever the install holds. */
  rehearse(): void {
    this.reset();
    this.rehearsal = true;
    this.introPending = true;
  }

  /**
   * The intro has played, or was skipped: what it stood in front of — Welcome,
   * or the app — is next, and it does not play again.
   */
  introPlayed(): void {
    localStorage.setItem(INTRO_PLAYED_KEY, new Date().toISOString());
    this.introSeen = true;
    this.introPending = false;
  }

  goTo(page: OnboardingPage): void {
    // Walking back to the welcome page gives up on the attempt, including the
    // server it may already have registered and what that server answered.
    // Holding on to that reference would point the next attempt's save at a row
    // the user is free to delete in the meantime — the window is the workspace
    // again the moment one exists — and nothing short of a restart would clear
    // it.
    if (page === 'welcome') {
      this.server = null;
      this.via = 'external';
      this.serverWorkspaces = null;
      this.joinOfferCount = 0;
      this.registeredOn = null;
      this.signInSkipped = false;
    } else {
      this.begun = true;
    }
    this.page = page;
  }

  /** Step back to the previous page, staying put where there is none. Returns the page now on screen. */
  back(): OnboardingPage {
    const previous = this.previousPage;
    if (previous !== null) this.goTo(previous);
    return this.page;
  }

  /**
   * A managed path has registered its server.
   *
   * Reported from an effect that fires on every render of a page whose stack is
   * up, so writing the same pair again has to be a no-op — a fresh object each
   * time would notify, re-render and report again without end.
   */
  registered(page: OnboardingPage, serverId: string): void {
    if (this.registeredOn?.page === page && this.registeredOn.serverId === serverId) return;
    this.registeredOn = { page, serverId };
  }

  /**
   * A server was added or found. Signing in to it is next, unless this Console
   * is signed in to it already — replaying these pages against a server it
   * knows — when the workspace is.
   */
  connected(server: SwitchServer, via: 'external' | 'cloud', signedIn: boolean): void {
    this.server = server;
    this.via = via;
    this.signInSkipped = signedIn;
    this.begun = true;
    this.page = signedIn ? 'pickWorkspace' : 'signIn';
  }

  /**
   * The stack on this computer is up, and Console signed in to it as its
   * admin: there is no sign-in page, so the workspace is next.
   */
  startedLocally(server: SwitchServer): void {
    this.server = server;
    this.via = 'local';
    this.signInSkipped = false;
    this.begun = true;
    this.page = 'pickWorkspace';
  }

  /**
   * What the server answered when asked which workspaces this account is in.
   *
   * Kept so the create page knows whether there was anything to come back to:
   * an account with no membership is sent straight to the form, and offering it
   * a Back to a list of nothing would be a door onto a blank wall.
   */
  resolved(workspaces: Workspace[], joinOfferCount: number): void {
    this.serverWorkspaces = workspaces;
    this.joinOfferCount = joinOfferCount;
  }

  /** Whether Pick a workspace had anything to offer: a membership, an invitation or an open workspace. */
  get pickerHasChoices(): boolean {
    return (this.serverWorkspaces?.length ?? 0) > 0 || this.joinOfferCount > 0;
  }

  reset(): void {
    this.page = 'welcome';
    this.server = null;
    this.via = 'external';
    this.serverWorkspaces = null;
    this.joinOfferCount = 0;
    this.registeredOn = null;
    this.signInSkipped = false;
    this.begun = false;
    this.rehearsal = false;
  }
}

export const onboardingStore = new OnboardingStore();
