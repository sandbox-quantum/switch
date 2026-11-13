import { useQuery } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import {
  useManagedAgents,
  withoutManaged,
} from '@renderer/features/managed-agents/use-managed-agents';
import { BuddyAvatar } from '@renderer/features/switch-buddy/buddy-avatar';
import { buddyOffered, isBuddy } from '@renderer/features/switch-buddy/buddy-identity';
import { askBuddy, openBuddyChat } from '@renderer/features/switch-buddy/open-buddy';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { report } from '@renderer/lib/telemetry/report';
import { Button } from '@renderer/lib/ui/button';
import { ONBOARDING_BACKDROP } from '@renderer/lib/ui/wizard-frame';
import { log } from '@renderer/utils/logger';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';
import {
  machineUnavailableReason,
  type SignedIn,
  ServerSignInFields,
  useServerSignIn,
} from '../server-sign-in';
import { loadSwitchCloudOrigin, managedCloudServerId } from '../switch-cloud-origin';
import { switchRoomsStore } from '../switch-rooms-store';
import { useListedRoomsInWorkspace } from '../use-listed-rooms';
import { administersWorkspaceInScope } from '../workspace-admin';
import { HOME_CHIP_TEXT, type HomeChipId, homeChips } from './home-chips';

const card = 'rounded-lg border border-border bg-card p-4';

/** How long the suggestions wait on the lists they are picked from before going by what is known. */
const SUGGESTIONS_TIMEOUT_MS = 8_000;

type HomeAction = RendererTelemetryEvents['home_action'];

function reportHomeAction(action: HomeAction['action'], chip: HomeAction['chip']): void {
  report('home_action', { action, chip });
}

function Heading() {
  return (
    <h1 className="text-center text-3xl font-medium text-foreground">Let&rsquo;s work together</h1>
  );
}

/** Signed out: the account's state, and the server's own ways to sign in. */
export const SignedOutPanel = observer(function SignedOutPanel({ serverId }: { serverId: string }) {
  const signIn = useServerSignIn(serverId);
  const onSignedIn = (signedIn: SignedIn) => {
    void loadSwitchCloudOrigin().then(() => {
      if (serverId !== managedCloudServerId()) return;
      const reason = machineUnavailableReason(signedIn);
      if (reason) toast({ title: 'Your cloud machine is not starting', description: reason });
    });
  };

  return (
    <div className="flex w-full max-w-[560px] flex-col gap-4">
      <div className={`${card} flex items-center gap-2 text-sm`}>
        <span aria-hidden className="inline-block size-2 rounded-full bg-red-500" />
        <span className="text-foreground-muted">Not signed in</span>
      </div>
      <div className={`${card} space-y-4`}>
        <p className="text-sm text-foreground-muted">Sign in to connect to this server.</p>
        <ServerSignInFields
          signIn={signIn}
          idPrefix="switch-login"
          onSignedIn={onSignedIn}
          passwordSubmit={
            <Button
              size="sm"
              className="self-start"
              disabled={!signIn.canSubmitForm}
              onClick={() =>
                void signIn.submitForm().then((signedIn) => signedIn && onSignedIn(signedIn))
              }
            >
              {signIn.submitLabel}
            </Button>
          }
        />
      </div>
    </div>
  );
});

/** Signed in, and switch-buddy has no AI provider to run on yet. */
export function ConnectAiPanel({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string | null;
}) {
  // Without switch-buddy there is nothing for a provider to be connected to here.
  const offered = buddyOffered(useFeatureFlags(serverId));
  const available = offered && workspaceId !== null;
  const connect = () => {
    if (!available) return;
    reportHomeAction('connect_ai', 'none');
    showModal('buddySetupModal', {
      serverId,
      workspaceId,
      onSuccess: (agent) => void openBuddyChat(serverId, agent),
    });
  };

  return (
    <div className="flex w-full max-w-[560px] flex-col items-center gap-8">
      <Heading />
      <div
        className="flex w-full items-center justify-between gap-4 rounded-2xl bg-background-secondary-2 px-5 py-4"
        style={{ backgroundImage: ONBOARDING_BACKDROP }}
      >
        <p className="text-sm text-foreground">Connect to an AI provider to get started</p>
        {/* The title sits on a wrapper: a disabled button shows no tooltip. */}
        <span
          className="shrink-0"
          title={offered ? undefined : 'This server does not offer switch-buddy.'}
        >
          <Button
            variant="outline"
            className="bg-background"
            disabled={!available}
            onClick={connect}
          >
            Connect to AI
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * The suggestions under the switch-buddy box, from the lists the app already
 * holds: the workspace's messaging apps, its agents and its rooms. Null until
 * those lists are read, or until waiting on them stops being worth it.
 */
export function useHomeChips(
  serverId: string,
  workspaceId: string | null,
  buddy: ManagedAgentView | null
): HomeChipId[] | null {
  const bridges = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const managed = useManagedAgents(serverId);
  const rooms = useListedRoomsInWorkspace(workspaceId);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!agentsStore.loaded) void agentsStore.load();
  }, []);
  useEffect(() => {
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), SUGGESTIONS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [serverId, workspaceId]);

  // A failed read is settled, so the page stops waiting on it, but it is not
  // known: what it would have said must not decide a suggestion.
  useEffect(() => {
    if (bridges.isError)
      log.warn('Home suggestions: could not read the messaging apps', {
        error: String(bridges.error),
      });
  }, [bridges.isError, bridges.error]);
  useEffect(() => {
    if (managed.isError)
      log.warn('Home suggestions: could not read the managed agents', {
        error: String(managed.error),
      });
  }, [managed.isError, managed.error]);

  const bridgesSettled = bridges.isSuccess || bridges.isError;
  const agentsSettled = agentsStore.loaded && (managed.isSuccess || managed.isError);
  const roomsKnown = workspaceId !== null && switchRoomsStore.roomsLoadedFor(workspaceId);
  if (!(bridgesSettled && agentsSettled && roomsKnown) && !timedOut) return null;
  const bridgesKnown = bridges.isSuccess;
  const agentsKnown = agentsStore.loaded && managed.isSuccess;

  // Counted as the Your Agents page lists them: this Console's agents, less
  // the ones the server runs, plus every agent the server runs.
  const agents = [
    ...withoutManaged(agentsStore.agentsOnServer(serverId), managed.data),
    ...(managed.data ?? []),
  ];
  const otherAgentCount = agents.filter((agent) => !isBuddy({ name: agent.name })).length;
  // The buddy's own chats, its Welcome chat or a channel it was continued in, are not the team's rooms.
  const otherRoomCount = rooms.filter((room) => {
    const members = chatsStore.chat(room.id)?.agents;
    return !(
      buddy &&
      members !== undefined &&
      members.length > 0 &&
      members.every((member) => member.id === buddy.agentId)
    );
  }).length;

  // Unknown lists count as nothing missing: a suggestion is only made on evidence.
  return homeChips({
    hasMessagingApp: !bridgesKnown || (bridges.data?.length ?? 0) > 0,
    isAdmin: administersWorkspaceInScope(serverId),
    otherAgentCount: agentsKnown ? otherAgentCount : Number.POSITIVE_INFINITY,
    otherRoomCount: roomsKnown ? otherRoomCount : Number.POSITIVE_INFINITY,
  });
}

/** Signed in with AI connected: ask switch-buddy, or start from a suggestion. */
export function AskBuddyPanel({
  serverId,
  buddy,
  chips,
}: {
  serverId: string;
  buddy: ManagedAgentView;
  chips: HomeChipId[];
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const ask = async (text: string, chip: HomeChipId | null): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    reportHomeAction(chip === null ? 'message' : 'chip', chip ?? 'none');
    setSending(true);
    try {
      await askBuddy(serverId, buddy, body);
    } catch (cause) {
      // The draft stays in the box, to send again.
      toast({
        title: 'Could not open the chat with switch-buddy',
        description: failureText(cause, 'Switch did not answer.'),
        variant: 'destructive',
      });
      setSending(false);
    }
  };

  return (
    <div className="flex w-full max-w-[720px] flex-col items-center gap-6">
      <Heading />
      <div className="relative w-full">
        <BuddyAvatar
          size={72}
          shape="tile"
          className="absolute -top-14 -left-12 -rotate-6 shadow-sm"
        />
        <form
          className="flex w-full items-center gap-2 rounded-2xl border border-border bg-background px-5 py-3 shadow-sm focus-within:border-foreground-muted"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(draft, null);
          }}
        >
          <input
            aria-label="Ask switch-buddy anything"
            placeholder="Ask switch-buddy anything"
            value={draft}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-muted"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-sm"
            aria-label="Send"
            disabled={sending || !draft.trim()}
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {chips.map((chip) => (
          <Button
            key={chip}
            variant="outline"
            disabled={sending}
            onClick={() => void ask(HOME_CHIP_TEXT[chip], chip)}
          >
            {HOME_CHIP_TEXT[chip]}
          </Button>
        ))}
      </div>
    </div>
  );
}
