import { observer } from 'mobx-react-lite';
import { AgentStatusIndicator } from '@renderer/features/sessions/components/agent-status-indicator';
import { sessionAgentStatus } from '@renderer/features/sessions/stores/session-selectors';
import { type SessionStore } from '@renderer/features/sessions/stores/session-store';
import { useDelayedBoolean } from '@renderer/lib/hooks/use-delay-boolean';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

/**
 * Sidebar trailing slot: a spinner while the session is being created, the
 * status dot while its agent is working, and nothing at all otherwise. A row
 * that is not doing anything says nothing here.
 *
 * The width is fixed so a spinner appearing does not shorten the title beside
 * it, and the parent right-aligns the cluster.
 */
function Slot({ children }: { children: React.ReactNode }) {
  return <span className="flex w-[3ch] shrink-0 items-center justify-end">{children}</span>;
}

export const SessionSidebarTrailingSlot = observer(function SessionSidebarTrailingSlot({
  session,
}: {
  session: SessionStore;
}) {
  const delayedIsBootstrapping = useDelayedBoolean(session.isBootstrapping, 500);

  if (delayedIsBootstrapping) {
    return (
      <Slot>
        <Tooltip>
          <TooltipTrigger>
            <span className="flex size-6 items-center justify-center">
              <Spinner className="size-3.5 text-foreground-muted" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Creating session…</TooltipContent>
        </Tooltip>
      </Slot>
    );
  }

  // Only a working agent draws here. The other non-idle states render nothing,
  // so testing for "not idle" would fill the slot with an empty indicator.
  if (sessionAgentStatus(session) === 'working') {
    return (
      <Slot>
        <AgentStatusIndicator status="working" />
      </Slot>
    );
  }

  return null;
});
