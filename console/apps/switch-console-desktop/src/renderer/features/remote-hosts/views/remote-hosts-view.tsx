/**
 * The remote-hosts list (CHOO-1809).
 *
 * Rendering this page costs nothing. Each row shows a status derived from the
 * central reachability model and the host's persisted plan — no SSH round
 * trips, no probing on mount. The previous version fired a full dependency
 * sweep per row the instant the page opened, which is what made it slow and
 * unreliable with more than one host onboarded.
 *
 * Rows use the same language as the agents settings page — icon tile, name,
 * status pill — so hosts and agents read as one product.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Server, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { PageHeader } from '@renderer/lib/components/page-header';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Label } from '@renderer/lib/ui/label';
import { Spinner } from '@renderer/lib/ui/spinner';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { log } from '@renderer/utils/logger';
import { deriveHostStatus, type HostStatus } from '@shared/core/remote-hosts/host-status';
import type { HostSetupPlan } from '@shared/core/remote-hosts/setup';
import { SWITCH_DOCS_REMOTE_HOSTING_URL } from '@shared/urls';
import { hostReachabilityStore } from '../host-reachability-store';
import { useAllHostSetupPlans } from '../setup/use-host-setup';

export const REMOTE_HOSTS_QUERY_KEY = ['remote-hosts'];

/**
 * Volatile flag: the SSH host alias just added by the Add Host modal, consumed
 * once by `remote-host-view.tsx` to auto-expand the Load Existing Agents
 * section on the post-add-host page visit.
 */
export let justAddedHost: string | null = null;

/** Consume the flag — returns the value and clears it. */
export function consumeJustAddedHost(sshHost: string): boolean {
  if (justAddedHost === sshHost) {
    justAddedHost = null;
    return true;
  }
  return false;
}

type HostFilter = 'all' | 'ready' | 'attention';

type RemoteHost = { sshHost: string; name: string };

function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <div className="px-3 py-2">
      <Label>
        {children}
        {` (${count})`}
      </Label>
    </div>
  );
}

/**
 * One host row.
 *
 * Reachability wins over setup state: a host we cannot reach is reported as
 * unreachable, never as "dependency missing" — that conflation is exactly what
 * CHOO-1682/1780 set out to end. The derivation lives in `deriveHostStatus`, so
 * this row and the host's own page cannot disagree.
 */
const HostRow = observer(function HostRow({
  host,
  plan,
  onOpen,
  onRemoved,
}: {
  host: RemoteHost;
  plan: HostSetupPlan | null;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const status = deriveHostStatus(hostReachabilityStore.get(host.sshHost), plan);

  return (
    <div className="group flex w-full items-center gap-3 rounded-lg p-3 hover:bg-background-1">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-background-1 p-1.5 group-hover:bg-background-2">
          <Server className="size-4 text-foreground-muted" />
        </div>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{host.name}</span>
          <span className="truncate text-xs text-foreground-muted">{host.sshHost}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        <RemoveHostButton sshHost={host.sshHost} name={host.name} onRemoved={onRemoved} />
        <ChevronRight className="size-4 text-foreground-muted" />
      </div>
    </div>
  );
});

export const RemoteHostsSettingsPage = observer(function RemoteHostsSettingsPage() {
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const [filter, setFilter] = useState<HostFilter>('all');
  const showAddHost = useShowModal('addHostModal');

  const { data: hosts, isLoading } = useQuery({
    queryKey: REMOTE_HOSTS_QUERY_KEY,
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const list = useMemo(() => hosts ?? [], [hosts]);

  const sshHosts = useMemo(() => list.map((host) => host.sshHost), [list]);
  const plans = useAllHostSetupPlans(sshHosts);

  useEffect(() => {
    void hostReachabilityStore.hydrate();
  }, []);

  const statuses = useMemo(() => {
    const byHost = new Map<string, HostStatus>();
    for (const host of list) {
      byHost.set(
        host.sshHost,
        deriveHostStatus(
          hostReachabilityStore.get(host.sshHost),
          plans.data?.[host.sshHost] ?? null
        )
      );
    }
    return byHost;
  }, [list, plans.data]);

  const ready = useMemo(
    () => list.filter((host) => statuses.get(host.sshHost)?.kind === 'ready'),
    [list, statuses]
  );
  const attention = useMemo(
    () => list.filter((host) => statuses.get(host.sshHost)?.kind !== 'ready'),
    [list, statuses]
  );

  const openHost = (sshHost: string) => navigate('remoteHost', { sshHost });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: REMOTE_HOSTS_QUERY_KEY });
  };

  const renderRows = (rows: RemoteHost[]) =>
    rows.map((host) => (
      <div key={host.sshHost} className="w-full py-0.5">
        <HostRow
          host={host}
          plan={plans.data?.[host.sshHost] ?? null}
          onOpen={() => openHost(host.sshHost)}
          onRemoved={invalidate}
        />
      </div>
    ));

  // Scrolling and width belong to the settings shell this now sits in, so the
  // list contributes neither.
  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        sticky
        title="Remote hosts"
        description={
          <>
            Host your agents on any SSH devices, allowing your team to work with them 24/7. Check
            out this{' '}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                void openExternalUrl(
                  SWITCH_DOCS_REMOTE_HOSTING_URL,
                  'Could not open the documentation'
                )
              }
            >
              doc for cloud hosting ↗︎
            </button>
            .
          </>
        }
      >
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            multiple={false}
            value={[filter]}
            onValueChange={([value]) => {
              if (value) setFilter(value as HostFilter);
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="ready">Ready</ToggleGroupItem>
            <ToggleGroupItem value="attention">Needs setup</ToggleGroupItem>
          </ToggleGroup>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void showAddHost({
                onboarded: sshHosts,
                onAdded: (sshHost) => {
                  invalidate();
                  justAddedHost = sshHost;
                  navigate('remoteHost', { sshHost });
                },
              })
            }
          >
            <Plus className="size-4" /> Add host
          </Button>
        </div>
      </PageHeader>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Loading hosts…
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          No remote hosts yet. Add one above to get started.
        </p>
      ) : filter === 'ready' ? (
        ready.length > 0 ? (
          <div>
            <SectionLabel count={ready.length}>Ready</SectionLabel>
            {renderRows(ready)}
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">No host is ready yet.</p>
        )
      ) : filter === 'attention' ? (
        attention.length > 0 ? (
          <div>
            <SectionLabel count={attention.length}>Needs setup</SectionLabel>
            {renderRows(attention)}
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">Every host is ready.</p>
        )
      ) : (
        <div className="flex flex-col">
          {attention.length > 0 && (
            <section>
              <SectionLabel count={attention.length}>Needs setup</SectionLabel>
              {renderRows(attention)}
            </section>
          )}
          {ready.length > 0 && (
            <section className="pt-2">
              <SectionLabel count={ready.length}>Ready</SectionLabel>
              {renderRows(ready)}
            </section>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Removing a host drops its setup progress as well as the row, so it asks
 * first. The previous version deleted on a single click of a trash icon.
 */
function RemoveHostButton({
  sshHost,
  name,
  onRemoved,
}: {
  sshHost: string;
  name: string;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation({
    mutationFn: () => rpc.remoteHosts.removeHost(sshHost),
    onError: (error) => log.error('Failed to remove remote host', { sshHost, error }),
    onSuccess: () => {
      setConfirming(false);
      onRemoved();
    },
  });

  if (!confirming) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${name}`}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" />
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-foreground-muted">Remove?</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={mutation.isPending}
        onClick={() => setConfirming(false)}
      >
        No
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Removing…' : 'Remove'}
      </Button>
    </span>
  );
}

/**
 * Remote hosts are a tab of Settings, not a view of their own. This entry
 * survives only to catch persisted snapshots and older navigation that still
 * name the standalone view, and send them to the tab. `discardParams` stops the
 * stale entry being fed back on the next attempt.
 */
export const remoteHostsView = {
  MainPanel: RemoteHostsSettingsPage,
  canActivate: (): GuardResult => ({
    ok: false,
    redirect: 'settings',
    params: { tab: 'remote-hosts' },
    discardParams: true,
  }),
} satisfies ViewDefinition;
