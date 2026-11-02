import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { offerAccountLinkAfterConnect } from '@renderer/features/switch-servers/offer-account-link';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { reportOpenAttempt } from '@renderer/lib/open-external';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { type BuddyResume, buddyResumeBridges, buddySetupStep } from './buddy-setup-step';
import {
  BUDDY_CHAT_NAME,
  buddyHandoffRequestId,
  continueBuddyInSlack,
  resumeBuddyInSlack,
} from './open-buddy';

/**
 * The setup cards under the greeting in the buddy's Welcome chat: pick Slack,
 * connect it, link your account, then continue with the buddy in a private
 * Slack channel. Drawn only in the Welcome chat.
 */
export const BuddySetupCards = observer(function BuddySetupCards({
  serverId,
  workspaceId,
  agentId,
  roomId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  roomId: string;
}) {
  const chat = chatsStore.chat(roomId);
  if (!chat || chat.name !== BUDDY_CHAT_NAME || chat.bridgeType !== null) return null;
  return <Cards serverId={serverId} workspaceId={workspaceId} agentId={agentId} />;
});

const Cards = observer(function Cards({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const showConnect = useShowModal('connectMessagingAppModal');
  const [picked, setPicked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
  });
  const ids = useMyIdentities(workspaceId);
  const resumeBridges = buddyResumeBridges(bridgesQuery.data ?? null, ids.identities);
  const resumeQueries = useQueries({
    queries: resumeBridges.map((bridge) => ({
      queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      queryFn: () => resumeBuddyInSlack(serverId, agentId, bridge.id),
      retry: false,
      staleTime: Infinity,
    })),
  });
  const resumes: Record<string, BuddyResume> = {};
  resumeBridges.forEach((bridge, index) => {
    const query = resumeQueries[index];
    if (query.isError) resumes[bridge.id] = 'failed';
    else if (query.isSuccess) resumes[bridge.id] = query.data;
  });
  const step = buddySetupStep({
    bridges: bridgesQuery.data ?? null,
    identities: ids.identities,
    resumes,
    failed: bridgesQuery.isError || ids.error != null,
  });
  const retry = () => {
    void bridgesQuery.refetch();
    ids.refresh();
    for (const query of resumeQueries) if (query.isError) void query.refetch();
  };

  const doneRoomId = step.kind === 'done' ? step.chat.roomId : null;
  const roomQuery = useQuery({
    queryKey: ['buddy-handoff-room', workspaceId, doneRoomId],
    queryFn: () => rpc.workspaces.getRoomDetail({ workspaceId, roomId: doneRoomId as string }),
    enabled: doneRoomId !== null,
  });
  const channelUrl = roomQuery.data?.externalChannelUrl ?? null;
  const openSlack = (url: string) =>
    void reportOpenAttempt(
      rpc.switchRooms.openRoomChannel({ serverId, channelUrl: url }),
      'Could not open Slack',
      url
    );

  const create = async (bridge: RemoteBridge) => {
    setCreating(true);
    setCreateError(null);
    try {
      await continueBuddyInSlack(serverId, { agentId }, bridge.id);
      await queryClient.invalidateQueries({
        queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      });
    } catch (cause) {
      setCreateError(failureText(cause, 'Switch did not answer.'));
    } finally {
      setCreating(false);
    }
  };

  const slackIcon = <BridgeIcon bridgeType="slack" className="size-4" />;
  const pastChoice =
    picked || (step.kind !== 'loading' && step.kind !== 'unknown' && step.kind !== 'connect');

  return (
    <div className="mt-4 flex flex-col gap-2" data-testid="buddy-setup-cards">
      <Alert>
        <AlertTitle>Where does your team chat?</AlertTitle>
        <AlertDescription>Using something else? Just tell me below.</AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            variant={pastChoice ? 'default' : 'outline'}
            onClick={() => setPicked(true)}
          >
            {slackIcon}
            Slack
          </Button>
        </AlertAction>
      </Alert>

      {pastChoice && step.kind === 'loading' && (
        <Alert>
          <Spinner size="sm" />
          <AlertTitle>Checking Slack…</AlertTitle>
        </Alert>
      )}

      {pastChoice && step.kind === 'unknown' && (
        <Alert variant="destructive">
          <AlertTitle>Couldn’t check Slack</AlertTitle>
          <AlertDescription>Switch did not answer.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={retry}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {pastChoice && step.kind === 'connect' && (
        <Alert>
          <AlertTitle>Connect Slack</AlertTitle>
          <AlertDescription>Add Slack to your Switch workspace.</AlertDescription>
          <AlertAction>
            <Button size="sm" onClick={() => showConnect({ serverId, onClosed: retry })}>
              Connect Slack
            </Button>
          </AlertAction>
        </Alert>
      )}

      {step.kind === 'link' && (
        <Alert>
          <AlertTitle>Link your Slack account</AlertTitle>
          <AlertDescription>So I recognise you in {step.bridge.displayName}.</AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              onClick={() =>
                offerAccountLinkAfterConnect(workspaceId, {
                  bridgeId: step.bridge.id,
                  displayName: step.bridge.displayName,
                  directorySearchSupported: step.bridge.directorySearchSupported,
                })
              }
            >
              Link account
            </Button>
          </AlertAction>
        </Alert>
      )}

      {step.kind === 'create' && (
        <Alert variant={createError ? 'destructive' : 'default'}>
          <AlertTitle>Continue in Slack</AlertTitle>
          <AlertDescription>
            {createError ??
              `This creates a private Slack channel with you and switch-buddy in ${step.bridge.displayName}.`}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" disabled={creating} onClick={() => void create(step.bridge)}>
              {creating && <Spinner size="sm" />}
              {createError ? 'Try again' : 'Create channel and continue'}
            </Button>
          </AlertAction>
        </Alert>
      )}

      {step.kind === 'resuming' && (
        <Alert>
          <Spinner size="sm" />
          <AlertTitle>Finishing setup…</AlertTitle>
        </Alert>
      )}

      {doneRoomId && (
        <Alert>
          {slackIcon}
          <AlertTitle>Continued in Slack</AlertTitle>
          <AlertDescription>
            {channelUrl
              ? 'Our chat goes on there.'
              : roomQuery.isPending
                ? 'Looking up the Slack channel…'
                : 'Couldn’t get a link to the Slack channel. Find it in Slack.'}
          </AlertDescription>
          {channelUrl && (
            <AlertAction>
              <Button size="sm" onClick={() => openSlack(channelUrl)}>
                Open Slack
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
    </div>
  );
});
