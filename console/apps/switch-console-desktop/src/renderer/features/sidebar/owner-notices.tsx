import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import type { OwnerNotice } from '@shared/core/switch-servers/owner-notice';

type OwnerNoticesContentProps = {
  notices: OwnerNotice[];
  loading: boolean;
  loadError: boolean;
  unsupported: boolean;
  dismissError: boolean;
  dismissingId: string | null;
  onRetry: () => void;
  onDismiss: (id: string) => void;
};

/** The gateway supplies only notices addressed to the current owner. */
export function OwnerNoticesContent({
  notices,
  loading,
  loadError,
  unsupported,
  dismissError,
  dismissingId,
  onRetry,
  onDismiss,
}: OwnerNoticesContentProps) {
  if (!loading && !loadError && !unsupported && !dismissError && notices.length === 0) return null;
  return (
    <section aria-label="Agent invitation notices" className="mx-2 mt-2 text-xs">
      {loading && <p role="status">Checking agent invitation notices…</p>}
      {unsupported && (
        <div role="status" className="flex items-center justify-between gap-2">
          <span>
            This Switch server doesn’t support agent invitation notices. Update it to see them.
          </span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Check again
          </Button>
        </div>
      )}
      {loadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-foreground-warning"
        >
          <span>Couldn’t check agent invitation notices.</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {dismissError && <p role="alert">Couldn’t dismiss the notice. Please try again.</p>}
      {notices.length > 0 && (
        <ul className="max-h-40 space-y-2 overflow-y-auto" aria-label="Unverified invitations">
          {notices.map((notice) => (
            <li key={notice.id} className="rounded-md border border-border p-2 text-foreground">
              <p>
                <strong>{notice.agentName}</strong> was added to <strong>{notice.roomName}</strong>,
                but Switch couldn’t verify who added it. Contact a room member if you want it
                removed.
              </p>
              <Button
                size="xs"
                variant="ghost"
                disabled={dismissingId !== null}
                aria-label={`Dismiss notice for ${notice.agentName} in ${notice.roomName}`}
                onClick={() => onDismiss(notice.id)}
              >
                {dismissingId === notice.id ? 'Dismissing…' : 'Dismiss'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OwnerNoticesForUser({
  workspaceId,
  userId,
  tenantId,
}: {
  workspaceId: string;
  userId: string;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['owner-notices', workspaceId, userId, tenantId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => rpc.workspaces.listOwnerNotices({ workspaceId, userId, tenantId }),
    refetchInterval: (query) => (query.state.data?.supported === false ? false : 30_000),
    refetchOnWindowFocus: (query) => query.state.data?.supported !== false,
    refetchOnReconnect: (query) => query.state.data?.supported !== false,
    gcTime: 0,
    retry: 1,
  });
  const dismiss = useMutation({
    mutationFn: (noticeId: string) => rpc.workspaces.dismissOwnerNotice({ workspaceId, noticeId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  return (
    <OwnerNoticesContent
      notices={!query.isError && query.data?.supported ? query.data.notices : []}
      loading={query.isLoading}
      loadError={query.isError}
      unsupported={query.data?.supported === false}
      dismissError={dismiss.isError}
      dismissingId={dismiss.isPending ? dismiss.variables : null}
      onRetry={() => void query.refetch()}
      onDismiss={(id) => dismiss.mutate(id)}
    />
  );
}

/** Re-key by workspace, tenant, and user so another owner's notices never carry over. */
export const OwnerNotices = observer(function OwnerNotices() {
  const workspaceId = workspacesStore.activeId;
  const tenantId = workspacesStore.active?.tenantId ?? null;
  const server = switchServersStore.activeServer;
  const status = server ? switchServersStore.statusFor(server.id) : null;
  const userId = status?.connected ? (status.user?.id ?? null) : null;
  if (!workspaceId || !userId) return null;
  if (!tenantId)
    return (
      <p role="status" className="mx-2 mt-2 text-xs">
        Connecting to the workspace to check invitation notices…
      </p>
    );
  return (
    <OwnerNoticesForUser
      key={`${workspaceId}:${userId}:${tenantId}`}
      workspaceId={workspaceId}
      userId={userId}
      tenantId={tenantId}
    />
  );
});
