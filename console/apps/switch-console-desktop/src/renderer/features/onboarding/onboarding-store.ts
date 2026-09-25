import { makeAutoObservable } from 'mobx';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';

/** Where a fresh install is in getting its first server. */
export type OnboardingPage =
  | 'welcome'
  | 'whoRuns'
  | 'local'
  | 'remoteHost'
  | 'connect'
  | 'signIn'
  | 'pickWorkspace'
  | 'createWorkspace'
  | 'linkAccounts';

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
class OnboardingStore {
  page: OnboardingPage = 'welcome';
  /** The server the connect page added, and the subject of the pages after it. */
  server: SwitchServer | null = null;
  /** The workspaces that server said the account is in, once it has been asked. */
  serverWorkspaces: Workspace[] | null = null;
  /**
   * The server a managed path brought up, and the page that brought it up.
   *
   * The page is kept with it because the two managed paths do not share one:
   * starting a stack on a host and then walking back to pick the local one
   * leaves a server that the page now on screen did not make, and an exit
   * offered to it would take the user somewhere they did not set up.
   */
  registeredOn: { page: OnboardingPage; serverId: string } | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  /**
   * Whether the user has committed to setting a server up.
   *
   * The welcome page is not in progress: it asks a question and nothing has
   * been started, so a launch that finds servers should go straight past it.
   */
  get inProgress(): boolean {
    return this.page !== 'welcome';
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
      this.serverWorkspaces = null;
      this.registeredOn = null;
    }
    this.page = page;
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

  connected(server: SwitchServer): void {
    this.server = server;
    this.page = 'signIn';
  }

  /**
   * What the server answered when asked which workspaces this account is in.
   *
   * Kept so the create page knows whether there was anything to come back to:
   * an account with no membership is sent straight to the form, and offering it
   * a Back to a list of nothing would be a door onto a blank wall.
   */
  resolved(workspaces: Workspace[]): void {
    this.serverWorkspaces = workspaces;
  }

  reset(): void {
    this.page = 'welcome';
    this.server = null;
    this.serverWorkspaces = null;
    this.registeredOn = null;
  }
}

export const onboardingStore = new OnboardingStore();
