import { focusComposerWhenOpened } from "@switch-console/chat-ui/components/chat-composer";
import { introduceChat } from "@switch-console/chat-ui/components/chat-entrance";
import { AskBuddyPanel, ConnectAiPanel } from "@switch-console/chat-ui/components/home-panels";
import { useChatHost } from "@switch-console/chat-ui/host";
import { findBuddy } from "@switch-console/chat-ui/model/buddy";
import { type HomeChipId, homeChips } from "@switch-console/chat-ui/model/home-chips";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { useQuery } from "@tanstack/react-query";
import { observer } from "mobx-react-lite";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { fetchBridges, loadAgents, loadRooms } from "../../data/api";
import { fetchManagedAgents } from "../../data/management";
import { GET_STARTED } from "../get-started/paths";
import { warn, webChatsClient } from "../chats/webChatClient";
import type { WebChats } from "../chats/webChats";
import { WEB_SERVER_ID } from "../chats/webServer";

function failureText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Starts a new chat with switch-buddy, `text` its first message, as Console's
 * Home does, and gives its room. The message goes through the chat's own
 * timeline, so it shows there as sending and a failed send stays with Retry.
 * Raises when the chat cannot be made, before anything is sent.
 */
async function askBuddy(web: WebChats, buddyId: string, text: string): Promise<string> {
  const chat = await webChatsClient.createChat({
    agentIds: [buddyId],
    name: null,
    requestId: crypto.randomUUID(),
    greeting: null,
  });
  web.chats.add(WEB_SERVER_ID, chat);
  web.titler.created(chat, false);
  web.chats.timelines.get(WEB_SERVER_ID, chat.roomId).send({
    body: text,
    threadRootId: null,
    mentionAgentIds: [],
    mentionUserIds: [],
    mentionSpans: [],
    files: [],
    requestId: null,
  });
  void web.titler.sent(WEB_SERVER_ID, chat.roomId, text);
  focusComposerWhenOpened(chat.roomId);
  // Your message slides in as the chat opens, and the buddy's answer when it comes.
  introduceChat(chat.roomId, "own-and-agent");
  return chat.roomId;
}

/**
 * The suggestions under the switch-buddy box, picked as Console picks them;
 * null until the lists they are picked from are read. A list that could not
 * be read counts as nothing missing: a suggestion is only made on evidence.
 */
function useHomeChips(web: WebChats, buddyId: string | null, userId: string, isAdmin: boolean): HomeChipId[] | null {
  const bridges = useQuery({ queryKey: ["home-bridges"], queryFn: fetchBridges, enabled: buddyId !== null });
  const agents = useQuery({ queryKey: ["home-agents"], queryFn: loadAgents, enabled: buddyId !== null });
  const rooms = useQuery({ queryKey: ["home-rooms"], queryFn: loadRooms, enabled: buddyId !== null });

  useEffect(() => {
    if (agents.isError) warn("Home suggestions: could not read the agents", { error: String(agents.error) });
  }, [agents.isError, agents.error]);
  useEffect(() => {
    if (rooms.isError) warn("Home suggestions: could not read the rooms", { error: String(rooms.error) });
  }, [rooms.isError, rooms.error]);

  const settled = (query: { isSuccess: boolean; isError: boolean }) => query.isSuccess || query.isError;
  if (buddyId === null || !settled(bridges) || !settled(agents) || !settled(rooms)) return null;

  const otherAgents = agents.data?.filter((agent) => agent.owner_id === userId && agent.id !== buddyId);
  // The buddy's own chats are not the team's rooms.
  const otherRooms = rooms.data?.filter((room) => {
    if (!room.viewer_is_member) return false;
    const members = web.chats.chat(room.id)?.agents;
    return !(members !== undefined && members.length > 0 && members.every((member) => member.id === buddyId));
  });
  return homeChips({
    hasMessagingApp: (bridges.data ?? null) === null || bridges.data!.length > 0,
    isAdmin,
    otherAgentCount: otherAgents?.length ?? Number.POSITIVE_INFINITY,
    otherRoomCount: otherRooms?.length ?? Number.POSITIVE_INFINITY,
  });
}

/**
 * Home where the dashboard has chats, as Console's Home: ask switch-buddy, or
 * start from a suggestion, and its chat opens with the message in it. Without
 * a switch-buddy yet, the way to Get started.
 */
export const BuddyHome = observer(function BuddyHome({
  web,
  managementOffered,
  setupOffered,
}: {
  web: WebChats;
  /** Whether the server runs agents, so a switch-buddy can exist. */
  managementOffered: boolean;
  /** Whether Get started is offered here. */
  setupOffered: boolean;
}) {
  const { session, capabilities } = useAuth();
  const userId = session!.user.id;
  const host = useChatHost();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    web.start();
    return () => web.stop();
  }, [web]);

  // shortcut: an existing switch-buddy counts as ready, without Console's check that its device and AI login are up; add it when the web reads device reports.
  const managed = useQuery({
    queryKey: ["home-managed-agents"],
    queryFn: fetchManagedAgents,
    enabled: managementOffered,
  });
  const buddy = findBuddy(managed.data);
  const chips = useHomeChips(web, buddy?.agent_id ?? null, userId, capabilities.administersWorkspace);

  const state =
    managementOffered && managed.isPending ? "loading" : !buddy ? "connectAi" : chips === null ? "loading" : "askBuddy";

  const ask = async (text: string): Promise<void> => {
    const agentId = buddy!.agent_id;
    try {
      const roomId = await askBuddy(web, agentId, text);
      navigate(`/chats/agents/${encodeURIComponent(agentId)}?chat=${encodeURIComponent(roomId)}`);
    } catch (cause) {
      host.toast({
        title: "Could not open the chat with switch-buddy",
        description: failureText(cause, "Switch did not answer."),
        variant: "destructive",
      });
      throw cause;
    }
  };

  const content =
    state === "loading" ? (
      <Spinner className="size-6 text-foreground-muted" />
    ) : state === "connectAi" ? (
      <>
        <ConnectAiPanel
          onConnect={setupOffered ? () => navigate(GET_STARTED) : null}
          unavailableReason={setupOffered ? null : "Switch does not offer switch-buddy here."}
        />
        {managed.isError && (
          <p className="mt-4 text-sm text-destructive">
            Couldn't look for your switch-buddy: {failureText(managed.error, "Switch did not answer.")}
          </p>
        )}
      </>
    ) : (
      <AskBuddyPanel onAsk={ask} chips={chips ?? []} />
    );

  return (
    <div
      className={`${SHARED_UI_CLASS} -m-8 flex min-h-0 flex-1 flex-col items-center justify-center bg-background px-6 py-8`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state}
          className="flex w-full flex-col items-center"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
});
