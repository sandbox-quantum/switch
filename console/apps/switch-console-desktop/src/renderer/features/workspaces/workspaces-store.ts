import { makeAutoObservable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { workspacesChangedChannel } from '@shared/core/workspaces/workspaceEvents';
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
 * The selection is persisted by the main process, so this mirrors it rather
 * than owning it — but the window is scoped to a workspace, so this is where
 * the scope is read and changed, and the servers store derives its own notion
 * of "which server" from it.
 */
export class WorkspacesStore {
  workspaces: Workspace[] = [];
  activeId: string | null = null;
  /** Ordinal of the most recent {@link setActive}; nothing renders it. */
  lastSwitch = 0;

  constructor() {
    makeAutoObservable(this, { lastSwitch: false });

    // The reconcile adds, matches and drops rows without a window asking, so
    // the calls the servers store makes are not the only times this list moves.
    // A membership gained or lost since the last launch would otherwise stay
    // invisible until the next one, and a row the boot sweep deleted would go
    // on being offered here after it had gone.
    events.on(workspacesChangedChannel, () => {
      void this.refresh();
    });
  }

  get active(): Workspace | null {
    return this.workspaces.find((w) => w.id === this.activeId) ?? null;
  }

  /**
   * The server the window is scoped to, for the parts of the app still keyed by
   * one.
   *
   * Derived rather than stored alongside the workspace: the server is simply
   * the one hosting the selection, and the main process reads it back the same
   * way, so the two cannot come to disagree about which server the app is on.
   */
  get activeServerId(): string | null {
    return this.active?.serverId ?? null;
  }

  /**
   * Scope the window to a workspace.
   *
   * Raises if the selection does not take. The caller shows it: a switch that
   * failed quietly would leave the sidebar listing one workspace's rooms under
   * another one's name, which looks like data loss rather than a failed click.
   *
   * Only the last switch started may write the mirror. Two clicks in quick
   * succession are two round trips that can finish in either order, and the
   * slower one landing second would leave this pointing at a workspace the main
   * process has already moved off — every read after it addressed under a name
   * the window is no longer showing.
   */
  async setActive(workspaceId: string): Promise<void> {
    const request = ++this.lastSwitch;
    await rpc.workspaces.setActive(workspaceId);
    if (request !== this.lastSwitch) return;
    runInAction(() => {
      this.activeId = workspaceId;
    });
  }

  /**
   * Create a workspace on a server and return it.
   *
   * Refreshes before returning, so a caller that scopes the window to the new
   * workspace is not doing it against a list that does not contain it yet.
   * Failures propagate: the name may be refused for a slug already in use, and
   * the form has to say so rather than appear to have worked.
   */
  async create(serverId: string, name: string): Promise<Workspace> {
    const workspace = await rpc.switchServers.createWorkspace({ serverId, name });
    await this.refresh();
    return workspace;
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
   * The workspace a view about a server acts in — its page, its cards, its
   * pickers.
   *
   * The active one when the window is scoped to that server, which is the
   * ordinary case: choosing a workspace in the switcher is how you reach its
   * pages at all. A view about some other server falls back to its only
   * workspace, since then there is nothing to choose.
   *
   * Null rather than a guess where neither applies. A server with no workspace
   * has not finished registering; a server with several, none of them active,
   * means the view is the one that has to say which, and addressing the wrong
   * one answers with somebody else's rooms while looking entirely correct.
   * Callers render the absence; they must not substitute the server id, which
   * would reach the gateway and succeed.
   */
  onServerInScope(serverId: string | null): Workspace | null {
    if (serverId === null) return null;
    const active = this.active;
    if (active?.serverId === serverId) return active;
    const found = this.onServer(serverId);
    return found.length === 1 ? found[0]! : null;
  }

  /**
   * {@link onServerInScope} as an id, for a view still routed by server.
   *
   * Null means "no workspace to act in yet", and a view must hold its reads and
   * writes until it is not: the list arrives asynchronously, so this answers
   * null on the first render of every such page.
   */
  idOnServerInScope(serverId: string | null): string | null {
    return this.onServerInScope(serverId)?.id ?? null;
  }
}

export const workspacesStore = new WorkspacesStore();
