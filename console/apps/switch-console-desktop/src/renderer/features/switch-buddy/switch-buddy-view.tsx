import { ChevronDown, Laptop, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { AgentProfile } from '@renderer/features/managed-agents/agent-profile';
import { agentSections } from '@renderer/features/managed-agents/agent-sections';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { SidebarMenuRow } from '@renderer/features/sidebar/sidebar-primitives';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { BUDDY_ICON_URL } from '@shared/core/agents/switch-buddy';
import { expectedBuddyName, firstNameOf, isBuddy } from './buddy-identity';
import { reportBuddyStep } from './buddy-telemetry';
import { BuddyWelcome } from './buddy-welcome';
import { BUDDY_CHAT_NAME, openBuddyChat } from './open-buddy';

type SwitchBuddyParams = { serverId: string };

/** The agent page's title bar, as it will be with the Welcome chat open. */
function SwitchBuddyTitlebar() {
  return (
    <Titlebar
      className="pr-0"
      leftClassName="w-[300px] shrink-0 self-stretch border-r border-border [-webkit-app-region:drag]"
      rightClassName="min-w-0 flex-1 justify-between gap-3 self-stretch border-b border-border pr-[7px] pl-4 [-webkit-app-region:drag]"
      rightSlot={<span className="truncate text-sm font-medium">{BUDDY_CHAT_NAME}</span>}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-[2px] pb-3">
      <p className="flex items-center gap-1 pb-1 text-xs font-medium text-foreground-muted">
        <ChevronDown className="size-3.5" />
        {title}
      </p>
      {children}
    </section>
  );
}

/**
 * switch-buddy before it exists, drawn as its agent page will be: its one
 * chat, Welcome, open beside the list, with its first message, and in place of
 * the message box a way to connect the AI provider it needs — Switch creates
 * no agent until one is ready. Once the person has a buddy this opens its real
 * page, on the same Welcome chat, which then works as any chat does.
 */
const SwitchBuddyPanel = observer(function SwitchBuddyPanel() {
  const { params } = useParams('switchBuddy');
  const { serverId } = params;
  const managed = useManagedAgents(serverId);
  const buddy = managed.data?.find(isBuddy) ?? null;
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const serviceConnections = useFeatureFlags(serverId).service_connections;

  useEffect(() => {
    if (buddy) void openBuddyChat(serverId, buddy);
  }, [buddy, serverId]);

  const connect = () => {
    if (workspaceId === null) return;
    reportBuddyStep('setup_opened', null);
    showModal('buddySetupModal', {
      serverId,
      workspaceId,
      onSuccess: (agent) => void openBuddyChat(serverId, agent),
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-border p-2">
        <AgentProfile
          name={expectedBuddyName(user)}
          iconUrl={BUDDY_ICON_URL}
          serverId={serverId}
          machine={{
            icon: Laptop,
            text: 'This computer',
            title: 'switch-buddy runs on this computer.',
          }}
          sections={agentSections(serviceConnections, undefined)}
          selected={null}
          onSelect={null}
        />
        <Section title="Direct chats">
          <SidebarMenuRow isActive onClick={() => {}}>
            <span className="flex size-6 shrink-0 items-center justify-center">
              <MessageSquare className="size-4 text-foreground-muted" />
            </span>
            <span className="min-w-0 flex-1 truncate">{BUDDY_CHAT_NAME}</span>
          </SidebarMenuRow>
        </Section>
        <Section title="Rooms">
          <p className="px-2 py-1 text-xs text-foreground-muted">Not in any room yet.</p>
        </Section>
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[860px] px-5 py-6">
            <BuddyWelcome firstName={firstNameOf(user?.name)} agentName={expectedBuddyName(user)} />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[860px] px-5 pb-5">
          <button
            type="button"
            onClick={connect}
            disabled={workspaceId === null}
            className="w-full rounded-full border border-border bg-background px-5 py-3 text-left text-sm text-foreground shadow-sm hover:bg-[var(--sel-soft)] disabled:opacity-60"
          >
            Connect an AI provider to chat with {expectedBuddyName(user)}
          </button>
          {workspaceId === null && (
            <p className="mt-2 text-xs text-foreground-muted">
              Open a workspace on this server first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

export const switchBuddyView = {
  WrapView: ({ children }: SwitchBuddyParams & { children: React.ReactNode }) => <>{children}</>,
  TitlebarSlot: SwitchBuddyTitlebar,
  MainPanel: SwitchBuddyPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof SwitchBuddyParams, unknown>>;
    if (typeof value.serverId !== 'string')
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<SwitchBuddyParams>;
