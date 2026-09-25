import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { Workspace } from '@shared/core/workspaces/workspaces';

/**
 * Renderer view of the workspaces this install knows about, and which one the
 * window is scoped to.
 *
 * Everything that reads or writes what a workspace owns — rooms, agents,
 * bridges, identities — is addressed by workspace id, so this is where a view
 * holding a server or an agent gets the id to address it with. The server's own
 * identity stays in the servers store: reachability, sign-in and the gateway
 * URL are facts about a gateway, not about whose data it answers with.
 *
 * The selection itself lives in the main process, so this mirrors it rather
 * than owning it — the servers store drives both through the same calls that
 * change the active server.
 */
export class WorkspacesStore {
  workspaces: Workspace[] = [];
  activeId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  get active(): Workspace | null {
    return this.workspaces.find((w) => w.id === this.activeId) ?? null;
  }

  async refresh(): Promise<void> {
    const [workspaces, activeId] = await Promise.all([
      rpc.workspaces.list(),
      rpc.workspaces.getActiveId(),
    ]);
    runInAction(() => {
      this.workspaces = workspaces;
      this.activeId = activeId;
    });
  }

  byId(workspaceId: string): Workspace | null {
    return this.workspaces.find((w) => w.id === workspaceId) ?? null;
  }

  /** The server hosting a workspace, or null while the list is not loaded. */
  serverIdFor(workspaceId: string): string | null {
    return this.byId(workspaceId)?.serverId ?? null;
  }

  onServer(serverId: string): Workspace[] {
    return this.workspaces.filter((w) => w.serverId === serverId);
  }

  /**
   * The one workspace on a server, for a view that is about the server itself —
   * its page, its cards, its pickers.
   *
   * Null on either edge rather than a guess. A server with none has not
   * finished registering; a server with several means the view is the one that
   * has to say which, and addressing the wrong one answers with somebody else's
   * rooms while looking entirely correct. Callers render the absence; they must
   * not substitute the server id, which would reach the gateway and succeed.
   */
  soleOnServer(serverId: string): Workspace | null {
    const found = this.onServer(serverId);
    return found.length === 1 ? found[0]! : null;
  }

  /**
   * {@link soleOnServer} as an id, tolerating a server that has not been chosen
   * — what a view still routed by server reads to address its workspace.
   *
   * Null means "no workspace to act in yet", and a view must hold its reads and
   * writes until it is not: the list arrives asynchronously, so this answers
   * null on the first render of every such page.
   */
  soleIdOnServer(serverId: string | null): string | null {
    return serverId === null ? null : (this.soleOnServer(serverId)?.id ?? null);
  }

  /** {@link soleOnServer} as an id, for a call that cannot proceed without one. */
  requireSoleIdOnServer(serverId: string): string {
    const workspace = this.soleOnServer(serverId);
    if (!workspace) {
      throw new Error(`Switch server ${serverId} does not have exactly one workspace`);
    }
    return workspace.id;
  }
}

export const workspacesStore = new WorkspacesStore();
