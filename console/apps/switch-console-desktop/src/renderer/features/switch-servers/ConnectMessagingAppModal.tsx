import {
  type ConnectedMessagingApp,
  ConnectMessagingAppDialog,
  type ConnectMessagingAppHost,
} from '@switch-console/chat-ui/components/connect-messaging-app';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel, bridgeSetupDocsUrl } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useOnUnmount } from '@renderer/lib/hooks/use-on-unmount';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { log } from '@renderer/utils/logger';
import type { CreateBridgeResult } from '@shared/core/switch-servers/switch-servers';
import { bridgeTypesQueryKey, fetchBridgeTypes } from './bridge-platforms-loader';
import { CONSOLE_MESSAGING_APP_WORDS, unreachableFromInternet } from './connect-form-fields';
import { offerAccountLinkAfterConnect } from './offer-account-link';
import { OwnAppGuide } from './own-app-guide';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';
import { WebhookAddressStep } from './webhook-address-step';
import { administersWorkspaceInScope } from './workspace-admin';

type ConnectMessagingAppModalArgs = {
  /** Attach to this server instead of the active one. */
  serverId?: string;
  /** Only this platform (`slack`), chosen already: the person picked it before opening the dialog. */
  platform?: string;
  /** Run however the dialog goes away. A chat connected from it after the
   *  first lands on no signal Switch Console receives, so this is when to
   *  look for it. */
  onClosed: () => void;
};

type Props = BaseModalProps<ConnectedMessagingApp> & ConnectMessagingAppModalArgs;

/** The shared Connect a messaging app dialog, reaching the server through Console's stores and IPC. */
export const ConnectMessagingAppModal = observer(function ConnectMessagingAppModal({
  serverId: overrideServerId,
  platform,
  onClosed,
  onSuccess,
  onClose,
}: Props) {
  useOnUnmount(onClosed);
  const { setCloseGuard } = useModalContext();

  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const workspaceId = workspacesStore.idOnServerInScope(serverId || null);
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const isAdmin = administersWorkspaceInScope(serverId);

  const queryClient = useQueryClient();
  // Every way of adding an app ends here, whoever opened the dialog: the
  // bridge list is re-read wherever it is shown (the server page, the
  // room-creation picker and the link step share the query key), and the
  // person is offered to link their own account on the new app.
  const finish = useCallback(
    (app: ConnectedMessagingApp) => {
      void queryClient.invalidateQueries({ queryKey: ['remote-bridges', workspaceId] });
      void switchRoomsStore.refreshRoomState();
      onSuccess(app);
      if (workspaceId !== null) offerAccountLinkAfterConnect(workspaceId, app);
    },
    [onSuccess, queryClient, workspaceId]
  );

  const typesQuery = useQuery({
    queryKey: bridgeTypesQueryKey(workspaceId),
    queryFn: () => fetchBridgeTypes(workspaceId as string),
    enabled: workspaceId !== null,
  });

  // Asked only of someone who may install: the route refuses everyone else, and
  // for them the dialog already says why nothing here will work.
  const installableQuery = useQuery({
    queryKey: ['messaging-apps', workspaceId],
    queryFn: () => rpc.workspaces.listMessagingApps(workspaceId as string),
    enabled: workspaceId !== null && isAdmin,
  });

  const ws = workspaceId as string;
  const host: ConnectMessagingAppHost = {
    scope: workspaceId ?? '',
    words: CONSOLE_MESSAGING_APP_WORDS,
    serverName: server?.name ?? null,
    hasWorkspace: workspaceId !== null,
    isAdmin,
    blocker: !server
      ? 'No Switch server is selected. Choose a server in the sidebar first.'
      : !isAdmin
        ? 'Connecting a messaging app requires an admin of this workspace. You are a member without admin rights, so the server would reject this.'
        : null,
    types: typesQuery,
    offers: installableQuery,
    teamsUnreachable: server !== null && unreachableFromInternet(server),
    platformLabel: bridgePlatformLabel,
    docsUrl: bridgeSetupDocsUrl,
    icons: { BridgeIcon, hasBridgeIcon },
    openExternal: openExternalUrl,
    // Console hands the page to the system browser once its address is known.
    openWhenReady: (failureTitle) => ({
      open: (url) => openExternalUrl(url, failureTitle),
      cancel: () => {},
    }),
    describeError: failureText,
    listBridges: () => rpc.workspaces.listBridges(ws),
    beginInstall: (platform) =>
      rpc.workspaces.beginMessagingAppInstall({ workspaceId: ws, platform }),
    appInstalled: (bridgeId) =>
      void rpc.workspaces
        .messagingAppInstalled({ workspaceId: ws, bridgeId })
        .catch((cause: unknown) =>
          log.warn('Could not report a messaging app install', { error: String(cause) })
        ),
    beginChatClaim: (platform) => rpc.workspaces.beginChatClaim({ workspaceId: ws, platform }),
    createBridge: async (app) => {
      const result = await rpc.workspaces.createBridge({ workspaceId: ws, ...app });
      return result.kind === 'created'
        ? { kind: 'created', bridge: result.bridge }
        : { kind: 'refused', message: messageFor(result) };
    },
    setCloseGuard,
    renderOwnAppGuide: (props) => <OwnAppGuide {...props} workspaceId={ws} />,
    renderWebhookStep: (props) => <WebhookAddressStep {...props} />,
    ConfirmButton,
  };

  return (
    <ConnectMessagingAppDialog
      host={host}
      platform={platform}
      onConnected={finish}
      onClose={onClose}
    />
  );
});

/** Turn a failed attach into something the user can act on. */
function messageFor(result: Exclude<CreateBridgeResult, { kind: 'created' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Connecting a messaging app requires an admin of this workspace.';
    case 'invalid':
      // The gateway validated the credentials against the platform's own config
      // model, so its wording is more specific than anything we could invent.
      return `The server rejected these details: ${result.message}`;
    case 'error':
      return result.message;
  }
}
