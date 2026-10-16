import { listManagedAgentRecords } from '@main/core/agent-migration/managed-agents-store';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgents } from '@main/core/agents/getAgents';
import { agentPlacements } from '@main/core/sdk-host/connection-health';
import { localWatcherControl } from '@main/core/sdk-host/local-host';
import { withSidecar } from '@main/core/sdk-host/sidecar-control';
import { deleteRoom, fetchMe } from '@main/core/switch-servers/gateway-client';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import type {
  ChatActivityTarget,
  ChatApproval,
  ChatApprovalAnswer,
  ChatControlCommand,
  RoomActivity,
} from '@shared/core/chats/activity';
import type {
  ChatMessage,
  ChatMessagesPage,
  ChatSendInput,
  ChatSummary,
  ChatUpload,
  ChatUploadInput,
} from '@shared/core/chats/chats';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type ActivityDeps, resolveChatActivity } from './activity';
import {
  connectChatStream,
  disconnectChatStream,
  resetChatStream,
  resyncChatStream,
} from './chat-streams';
import { generateChatTitle } from './chat-title';
import {
  answerChatApproval,
  archiveChat,
  createChat,
  fetchChatMedia,
  fetchChatMessages,
  fetchRoomActivity,
  listChats,
  renameChat,
  sendChatControl,
  sendChatMessage,
  uploadChatAttachment,
  warmChatAgent,
} from './gateway';

const onServer = withServerWorkspaceSession;

/** Short-lived reads repeated by every chat opened. */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = read();
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function dropServerCaches(serverId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${serverId}:`)) cache.delete(key);
}

const activityDeps: ActivityDeps = {
  localAgents: async (serverId) => {
    const moved = new Set((await listManagedAgentRecords()).map((record) => record.agentId));
    const linked = (await getAgents()).filter(
      (agent) => agent.serverId === serverId && agent.switchAgentId && !moved.has(agent.id)
    );
    return Promise.all(
      linked.map(async (agent) => ({
        id: agent.id,
        switchAgentId: agent.switchAgentId!,
        ssh: Boolean((await getAgentLocation(agent)).sshHost),
      }))
    );
  },
  placements: (serverId, consoleAgentId) => agentPlacements(serverId, consoleAgentId),
};

/**
 * Asks the agent's host to start the session a message to the room would
 * start, ahead of the message: a local or SSH host directly, any other
 * through core, which tells the agent's controller — unless `throughCore` is
 * false because core already did when it created the chat. A failure is
 * logged, never thrown, so it cannot get in the way of the chat.
 */
async function warmChat(
  params: { serverId: string; agentId: string; roomId: string },
  throughCore: boolean
) {
  const { serverId, agentId, roomId } = params;
  try {
    const local = (await activityDeps.localAgents(serverId)).find(
      (agent) => agent.switchAgentId === agentId
    );
    if (!local) {
      if (throughCore) await onServer(serverId, (server) => warmChatAgent(server, roomId, agentId));
      return;
    }
    await (local.ssh
      ? withSidecar(local.id, (client) => client.warm(roomId))
      : localWatcherControl(agentId).warm(roomId));
  } catch (error) {
    log.warn('Could not warm the agent’s session for a chat; its first message starts it', {
      serverId,
      agentId,
      roomId,
      error: String(error),
    });
  }
}

/**
 * The signed-in person's chats on a server: rooms they are a member of, read
 * and written through the gateway's `/chats` routes, kept live by one feed
 * per server and tenant. Sending only ever posts to the room — routing,
 * waking and starting a session belong to the agent's host.
 */
export const chatsController = createRPCController({
  /** Start (or keep) the server's live feed for the window's tenant; returns its state. */
  connect: (serverId: string) => connectChatStream(serverId),
  disconnect: (serverId: string) => {
    disconnectChatStream(serverId);
  },
  resync: (serverId: string) => {
    resyncChatStream(serverId);
  },
  /** Drop everything held for the server, as on sign-out. */
  reset: (serverId: string) => {
    dropServerCaches(serverId);
    resetChatStream(serverId);
  },
  /** Who the person is on the server, and the tenant the chats belong to. */
  identity: async (serverId: string): Promise<{ userId: string; tenantId: string | null }> => {
    const workspace = await requireWorkspaceForServer(serverId);
    const me = await cached(`${serverId}:me`, () => onServer(serverId, fetchMe));
    return { userId: me.id, tenantId: workspace.tenantId };
  },
  list: (serverId: string): Promise<ChatSummary[]> => onServer(serverId, listChats),
  create: async (params: {
    serverId: string;
    agentIds: string[];
    name: string | null;
    requestId: string;
  }): Promise<ChatSummary> => {
    const chat = await onServer(params.serverId, (server) => createChat(server, params));
    if (params.agentIds.length === 1)
      void warmChat(
        { serverId: params.serverId, agentId: params.agentIds[0], roomId: chat.roomId },
        false
      );
    return chat;
  },
  messages: (params: {
    serverId: string;
    roomId: string;
    beforeSeq: number | null;
    limit: number;
  }): Promise<ChatMessagesPage> =>
    onServer(params.serverId, (server) =>
      fetchChatMessages(server, params.roomId, {
        beforeSeq: params.beforeSeq,
        limit: Math.min(200, Math.max(1, params.limit)),
      })
    ),
  send: (input: ChatSendInput): Promise<ChatMessage[]> =>
    onServer(input.serverId, (server) =>
      sendChatMessage(server, input.roomId, {
        requestId: input.requestId,
        body: input.body,
        threadRootId: input.threadRootId,
        uploadIds: input.uploadIds,
      })
    ),
  upload: (input: ChatUploadInput): Promise<ChatUpload> =>
    onServer(input.serverId, (server) =>
      uploadChatAttachment(server, input.roomId, {
        uploadId: input.uploadId,
        name: input.name,
        mimeType: input.mimeType,
        bytes: Buffer.from(input.data, 'base64'),
      })
    ),
  /** A room attachment's bytes, base64, for display. */
  media: async (params: {
    serverId: string;
    roomId: string;
    uri: string;
  }): Promise<{ mimeType: string; data: string }> => {
    const media = await onServer(params.serverId, (server) =>
      fetchChatMedia(server, params.roomId, params.uri)
    );
    return { mimeType: media.mimeType, data: Buffer.from(media.bytes).toString('base64') };
  },
  archive: (serverId: string, roomId: string): Promise<void> =>
    onServer(serverId, (server) => archiveChat(server, roomId)),
  delete: (serverId: string, roomId: string): Promise<void> =>
    onServer(serverId, (server) => deleteRoom(server, roomId)),
  rename: (serverId: string, roomId: string, name: string): Promise<void> =>
    onServer(serverId, (server) => renameChat(server, roomId, name)),
  /** A short chat name from its first message, from the user's local Claude CLI. */
  title: (message: string): Promise<string> => generateChatTitle(message),
  /**
   * Where the agent's session for the chat runs, as seen from this machine.
   * Changes follow on the room health channel.
   */
  activity: (params: {
    serverId: string;
    agentId: string;
    roomId: string;
  }): Promise<ChatActivityTarget> => resolveChatActivity(activityDeps, params),
  /** Start the agent's session for an existing chat reopened empty; creating a chat starts it already. */
  warm: (params: { serverId: string; agentId: string; roomId: string }): Promise<void> =>
    warmChat(params, true),
  /** The room's turn steps and approval requests; changes follow on the activity channels. */
  roomActivity: (serverId: string, roomId: string): Promise<RoomActivity> =>
    onServer(serverId, (server) => fetchRoomActivity(server, roomId)),
  /** Post Stop, Reset or Compact for an agent; the command id its reply threads under. */
  control: (params: {
    serverId: string;
    roomId: string;
    requestId: string;
    agentId: string;
    command: ChatControlCommand;
  }): Promise<string> =>
    onServer(params.serverId, (server) =>
      sendChatControl(server, params.roomId, {
        requestId: params.requestId,
        agentId: params.agentId,
        command: params.command,
      })
    ),
  answerApproval: (params: {
    serverId: string;
    agentId: string;
    sessionId: string;
    requestId: string;
    answer: ChatApprovalAnswer;
  }): Promise<ChatApproval> =>
    onServer(params.serverId, (server) => answerChatApproval(server, params, params.answer)),
});
