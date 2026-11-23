import { makeAutoObservable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { type HostKeyProblem, hostKeyProblemsChannel } from '@shared/core/ssh/host-keys';

/**
 * Renderer mirror of the SSH host keys Switch Console refused and is waiting
 * on the user about. Hydrated once — a background connection may have been
 * refused before the window opened — then kept current by the pushed list.
 */
export class HostKeyPromptStore {
  problems: HostKeyProblem[] = [];
  private hydrated = false;

  constructor() {
    makeAutoObservable(this);
    events.on(hostKeyProblemsChannel, (problems) => {
      runInAction(() => {
        this.problems = problems;
      });
    });
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const problems = await rpc.remoteHosts.listHostKeyProblems();
    runInAction(() => {
      this.problems = problems;
    });
  }

  /** The one to ask about now; the rest wait their turn. */
  get current(): HostKeyProblem | null {
    return this.problems[0] ?? null;
  }

  /** Trust the presented key, then reconnect. */
  async trust(problem: HostKeyProblem): Promise<void> {
    await rpc.remoteHosts.trustHostKey({
      sshHost: problem.sshHost,
      fingerprint: problem.fingerprint,
    });
  }

  async dismiss(problem: HostKeyProblem): Promise<void> {
    await rpc.remoteHosts.dismissHostKey({
      sshHost: problem.sshHost,
      fingerprint: problem.fingerprint,
    });
  }
}

export const hostKeyPromptStore = new HostKeyPromptStore();
