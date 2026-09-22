import { makeAutoObservable } from 'mobx';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/** Where a fresh install is in getting its first server. */
export type OnboardingPage =
  | 'welcome'
  | 'whoRuns'
  | 'local'
  | 'connect'
  | 'signIn'
  | 'linkAccounts';

/**
 * The first-run flow's place in itself.
 *
 * Held in a store rather than in the page that draws it, for two reasons that
 * are really the same one: the flow outlives its own component. The shell takes
 * the window away from it whenever Settings is opened, so component state would
 * lose a half-typed gateway URL to a stray ⌘,. And the shell decides between
 * the first-run pages and the workspace from the server list — which stops
 * being empty halfway through the flow, the moment the server is added but
 * several pages before the user has signed in to it. Without somewhere to say
 * "still going", adding the server would throw the user out of the flow that
 * added it.
 */
class OnboardingStore {
  page: OnboardingPage = 'welcome';
  /** The server the connect page added, and the subject of the pages after it. */
  server: SwitchServer | null = null;

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
    this.page = page;
  }

  connected(server: SwitchServer): void {
    this.server = server;
    this.page = 'signIn';
  }

  reset(): void {
    this.page = 'welcome';
    this.server = null;
  }
}

export const onboardingStore = new OnboardingStore();
