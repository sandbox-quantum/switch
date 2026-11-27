import "@switch-console/chat-ui/theme.css";
import appLevelTokensShot from "@switch-console/chat-ui/assets/slack-setup/app-level-tokens.png";
import installAppShot from "@switch-console/chat-ui/assets/slack-setup/install-app.png";
import {
  type ConnectedMessagingApp,
  ConnectMessagingAppDialog,
  type ConnectMessagingAppHost,
  type MessagingAppCreated,
  type MessagingAppWords,
  type NewMessagingApp,
  WebhookAddressStep,
} from "@switch-console/chat-ui/components/connect-messaging-app";
import { SlackOwnAppGuide, type SlackSetupShot } from "@switch-console/chat-ui/components/slack-own-app-guide";
import { bridgeConfigFields, privateAddress } from "@switch-console/chat-ui/model/connect-messaging-app";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Dialog, DialogContent } from "@switch-console/chat-ui/primitives/dialog";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import {
  ApiError,
  beginAppInstall,
  beginChatClaim,
  checkSlackTokens,
  createBridge,
  fetchBridges,
  fetchBridgeTypes,
  fetchInstallablePlatforms,
  fetchSlackOwnAppSetup,
} from "../../data/api";
import { platformLabel } from "../../theme/format";
import { useWebBridgeIcons } from "../chats/WebChatHost";

const DOCS_URL = "https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps";

const WORDS: MessagingAppWords = {
  thisServer: "Switch",
  thisSwitchServers: "Switch’s",
  yourServers: "Switch’s",
  currentDefault: "the current default",
  onTheServer: "in Switch’s configuration",
  connection: "messaging app",
  appName: "Switch",
};

const SHOTS: Record<SlackSetupShot, string> = {
  "install-app": installAppShot,
  "app-level-tokens": appLevelTokensShot,
};

const messagingAppsQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

interface Props {
  open: boolean;
  /** The messaging app to open on, as its bridge type; "" to let the person pick. */
  initialType: string;
  onClose: () => void;
  onSuccess: (app: ConnectedMessagingApp) => void;
}

/** The server's sentence where it wrote one for a person, else the fallback with what went wrong. */
function describeError(error: unknown, fallback: string): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (error instanceof ApiError && /^[A-Z].{10,}[.!?]$/.test(raw)) return raw;
  return raw ? `${fallback} (${raw})` : fallback;
}

function openExternal(url: string): Promise<boolean> {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve(true);
}

/** A tab opened at the click, before anything is awaited: a browser blocks one opened later. Without one, the page takes this tab. */
function openWhenReady() {
  const tab = window.open("", "_blank");
  return {
    open: (url: string) => {
      if (tab === null) window.location.href = url;
      else tab.location.href = url;
      return Promise.resolve(true);
    },
    cancel: () => tab?.close(),
  };
}

async function createApp(app: NewMessagingApp): Promise<MessagingAppCreated> {
  try {
    const bridge = await createBridge(
      app.bridgeType,
      app.displayName,
      app.connectionConfig,
      app.channelCreationEnabled,
      app.setAsDefault,
    );
    return {
      kind: "created",
      bridge: {
        id: bridge.bridge_id,
        displayName: bridge.display_name,
        receivesWebhooks: bridge.receives_webhooks,
        webhookUrl: bridge.webhook_url,
      },
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401)
      return { kind: "refused", message: "Your session expired. Sign in again, then retry." };
    if (error.status === 403)
      return { kind: "refused", message: "Connecting a messaging app requires an admin of this workspace." };
    // Switch checked the details against the platform's own config, so its wording says what is wrong.
    if (error.status === 400 || error.status === 422)
      return { kind: "refused", message: `Switch rejected these details: ${error.message}` };
    throw error;
  }
}

async function messagingAppTypes() {
  return ((await fetchBridgeTypes()) ?? []).map((type) => ({
    key: type.key,
    fields: bridgeConfigFields(type.config_schema),
    channelCreationSupported: type.channel_creation_supported,
    directorySearchSupported: type.directory_search_supported ?? true,
    docsSlug: type.docs_slug ?? null,
  }));
}

function WebConfirmButton(props: { onClick: () => void; disabled: boolean; children: ReactNode }) {
  return <Button {...props} />;
}

/**
 * Console's Connect a messaging app dialog, on the web: Switch's own apps in
 * one click first, then your own app, with Slack's setup walked through and
 * its tokens checked as they are pasted. A click outside leaves it open, as
 * in Console; Escape closes it unless a connect is under way.
 */
export default function RegisterMessagingAppDialog({ open, initialType, onClose, onSuccess }: Props) {
  const [guarded, setGuarded] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next || details.reason === "outside-press" || (guarded && details.reason === "escape-key")) return;
        onClose();
      }}
    >
      <DialogContent>
        {open && (
          <QueryClientProvider client={messagingAppsQueryClient}>
            <ConnectApp
              platform={initialType || undefined}
              onConnected={(app) => {
                onSuccess(app);
                onClose();
              }}
              onClose={onClose}
              setGuarded={setGuarded}
            />
          </QueryClientProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectApp({
  platform,
  onConnected,
  onClose,
  setGuarded,
}: {
  platform: string | undefined;
  onConnected: (app: ConnectedMessagingApp) => void;
  onClose: () => void;
  setGuarded: (guarded: boolean) => void;
}) {
  const { session, canAdminTenant } = useAuth();
  const tenantId = session?.tenant?.id ?? "";
  const types = useQuery({ queryKey: ["messaging-app-types", tenantId], queryFn: messagingAppTypes });
  const offers = useQuery({
    queryKey: ["messaging-app-offers", tenantId],
    queryFn: async () => {
      const found = await fetchInstallablePlatforms();
      return {
        installable: [...found],
        claimable: (found.claimable ?? []).map((each) => ({
          platform: each.platform,
          connected: each.connected,
          canAddChat: each.can_add_chat,
        })),
      };
    },
    enabled: canAdminTenant,
  });
  const bridgeIcons = useWebBridgeIcons();
  const docsUrl = (key: string) => {
    const slug = types.data?.find((type) => type.key === key)?.docsSlug;
    return slug ? `${DOCS_URL}/${slug}` : DOCS_URL;
  };

  const host: ConnectMessagingAppHost = {
    scope: tenantId,
    words: WORDS,
    serverName: session?.tenant?.name ?? null,
    hasWorkspace: session?.tenant != null,
    isAdmin: canAdminTenant,
    blocker: canAdminTenant
      ? null
      : "Connecting a messaging app requires an admin of this workspace. You are a member without admin rights, so Switch would refuse it.",
    types,
    offers,
    // Reached at a private address, Switch is most likely not reachable from the internet either.
    teamsUnreachable: privateAddress(window.location.origin),
    platformLabel,
    docsUrl,
    icons: bridgeIcons,
    openExternal,
    openWhenReady,
    describeError,
    listBridges: async () =>
      ((await fetchBridges()) ?? []).map((bridge) => ({
        id: bridge.bridge_id,
        type: bridge.bridge_type,
        displayName: bridge.display_name,
      })),
    beginInstall: beginAppInstall,
    // Install reports are Switch Console's usage data; the dashboard sends none.
    appInstalled: () => {},
    beginChatClaim: async (key) => {
      const claim = await beginChatClaim(key);
      return { url: claim.url, code: claim.code, botHandle: claim.bot_handle };
    },
    createBridge: createApp,
    setCloseGuard: setGuarded,
    renderOwnAppGuide: (props) => (
      <SlackOwnAppGuide
        {...props}
        host={{
          scope: tenantId,
          thisServer: WORDS.thisServer,
          setup: async () => {
            const setup = await fetchSlackOwnAppSetup();
            return {
              createUrl: setup.create_url,
              manifestJson: setup.manifest ? JSON.stringify(setup.manifest, null, 2) : null,
            };
          },
          checkTokens: async ({ botToken, appToken }) => {
            const checked = await checkSlackTokens(botToken, appToken);
            return {
              workspaceId: checked.workspace_id,
              workspaceName: checked.workspace_name,
              botName: checked.bot_name,
            };
          },
          docsUrl: docsUrl("slack"),
          openExternal,
          describeError,
          // The picture opens full size in a tab, where Console expands it in place.
          renderShot: (shot, alt) => (
            <a href={SHOTS[shot]} target="_blank" rel="noopener noreferrer" className="block">
              <img src={SHOTS[shot]} alt={alt} className="w-full rounded-lg" />
            </a>
          ),
        }}
      />
    ),
    renderWebhookStep: ({ platform: key, webhookUrl }) => (
      <WebhookAddressStep label={platformLabel(key)} webhookUrl={webhookUrl} words={WORDS} />
    ),
    ConfirmButton: WebConfirmButton,
  };

  return <ConnectMessagingAppDialog host={host} platform={platform} onConnected={onConnected} onClose={onClose} />;
}
