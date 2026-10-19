import { makeAutoObservable } from 'mobx';

/** Where the answer to the switch-buddy pop-up is kept, per workspace, on this computer. */
const ANSWERED_KEY = (workspaceId: string) => `switchBuddy.introAnswered.${workspaceId}`;

/**
 * The pop-up that introduces switch-buddy to someone who has none: whether it
 * has been answered in a workspace, and whether the person chose Skip at Meet
 * switch-buddy since the app started, which keeps it away until the next
 * launch rather than asking again straight away.
 */
class BuddyIntroStore {
  skippedThisSession = false;
  /** Workspaces answered in this session, so the pop-up closes on the answer. */
  private answeredNow = new Set<string>();

  constructor() {
    makeAutoObservable(this);
  }

  skipped(): void {
    this.skippedThisSession = true;
  }

  isAnswered(workspaceId: string): boolean {
    return (
      this.answeredNow.has(workspaceId) || localStorage.getItem(ANSWERED_KEY(workspaceId)) !== null
    );
  }

  answered(workspaceId: string): void {
    localStorage.setItem(ANSWERED_KEY(workspaceId), new Date().toISOString());
    this.answeredNow.add(workspaceId);
  }
}

export const buddyIntroStore = new BuddyIntroStore();
