import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { sessionIssueChangedChannel } from '@shared/core/sessions/sessionEvents';

const ISSUE_TEXT = 'This session couldn’t start or stopped on an error — open it to see why.';

export const sessionIssueQueryKey = (sessionId: string) => ['session-issue', sessionId];

/**
 * A warning on a session row whose start failed or whose host stopped on a
 * failure. The reason itself is shown where it can be acted on — the open
 * session, which can restart it — so the row only says that there is one.
 * Asked once, then refreshed only when main says the session's health changed,
 * so a sidebar full of sessions does not poll.
 */
export function SessionIssueIndicator({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const { data: issue } = useQuery({
    queryKey: sessionIssueQueryKey(sessionId),
    queryFn: () => rpc.sdkHost.sessionIssue(sessionId),
    staleTime: Infinity,
  });
  useEffect(
    () =>
      events.on(
        sessionIssueChangedChannel,
        () => void queryClient.invalidateQueries({ queryKey: sessionIssueQueryKey(sessionId) }),
        sessionId
      ),
    [sessionId, queryClient]
  );
  if (!issue) return null;
  return (
    <Tooltip>
      <TooltipTrigger>
        <TriangleAlert
          aria-label={ISSUE_TEXT}
          className="h-3.5 w-3.5 shrink-0 text-foreground-destructive"
        />
      </TooltipTrigger>
      <TooltipContent>{ISSUE_TEXT}</TooltipContent>
    </Tooltip>
  );
}
