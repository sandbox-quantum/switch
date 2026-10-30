/** What the New room dialog asks the server for: a Switch Console chat when no messaging app is chosen, else a room bridged to the chosen one. */
export type RoomCreateRequest =
  | {
      kind: 'chat';
      params: {
        serverId: string;
        name: string;
        agentIds: string[];
        memberUserIds: string[];
        requestId: string;
        greeting: null;
        /** A room made here is a group even with one agent and nobody else. */
        kind: 'group';
      };
    }
  | {
      kind: 'room';
      params: {
        workspaceId: string;
        name: string;
        description: string;
        instructions: string | undefined;
        bridgeId: string;
        agentIds: string[];
      };
    };

export function roomCreateRequest(form: {
  serverId: string;
  workspaceId: string;
  /** Null for Switch Console. */
  bridgeId: string | null;
  name: string;
  description: string;
  instructions: string;
  agentIds: string[];
  /** The people to add; a bridged room is created without them. */
  memberUserIds: string[];
  requestId: string;
}): RoomCreateRequest {
  const name = form.name.trim();
  const agentIds = [...new Set(form.agentIds)];
  if (form.bridgeId === null)
    return {
      kind: 'chat',
      params: {
        serverId: form.serverId,
        name,
        agentIds,
        memberUserIds: [...new Set(form.memberUserIds)],
        requestId: form.requestId,
        greeting: null,
        kind: 'group',
      },
    };
  return {
    kind: 'room',
    params: {
      workspaceId: form.workspaceId,
      name,
      description: form.description.trim(),
      instructions: form.instructions.trim() || undefined,
      bridgeId: form.bridgeId,
      agentIds,
    },
  };
}

/** A room needs only a name; a bridged room's description is optional, as its channel topic is. */
export function canCreate(form: { name: string }) {
  return form.name.trim() !== '';
}

/**
 * One request id per form, as the direct-chat starter keeps one per agent: a
 * retry of an unchanged form after an answer that never arrived resumes the
 * chat it may already have made instead of making a second; a changed form,
 * or a create that succeeded, takes a new one.
 */
export class CreateRequestIds {
  private key: string | null = null;
  private id = '';

  constructor(private readonly newId: () => string) {}

  for(form: {
    bridgeId: string | null;
    name: string;
    agentIds: string[];
    memberUserIds: string[];
  }): string {
    const key = JSON.stringify([
      form.bridgeId,
      form.name.trim(),
      form.agentIds,
      form.memberUserIds,
    ]);
    if (key !== this.key) {
      this.key = key;
      this.id = this.newId();
    }
    return this.id;
  }

  succeeded(): void {
    this.key = null;
  }
}

/**
 * Whether a change to the picks removes the starting agent the dialog shows: only
 * that leaves it out. Other edits, made before or after it resolves, keep it.
 */
export function dropsStartingAgent(
  shown: { kind: string; id: string } | null,
  next: { kind: string; id: string }[]
): boolean {
  return shown !== null && !next.some((each) => each.kind === shown.kind && each.id === shown.id);
}

/**
 * Where the agent a room is made from stands: no such agent or already picked
 * (`resolved`), the agents still loading (`pending`, when Create waits), or it
 * cannot be picked because the agents failed to load or it is not among them.
 */
export function startingAgentResolution(state: {
  startingAgentId: string | undefined;
  applied: boolean;
  failed: boolean;
  loaded: boolean;
}): 'resolved' | 'pending' | 'failed' | 'unavailable' {
  if (state.startingAgentId === undefined || state.applied) return 'resolved';
  if (state.failed) return 'failed';
  return state.loaded ? 'unavailable' : 'pending';
}
