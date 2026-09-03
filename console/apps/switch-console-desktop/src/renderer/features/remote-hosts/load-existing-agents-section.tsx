/**
 * "Load existing agents" section for a remote host's page (CHOO-2560).
 *
 * Shows agents already configured on the host — by a colleague's Console or
 * an earlier install — that this Console does not yet manage. The user
 * selects which to load (attach); agents that need a provider pick get one
 * inline. Already-loaded agents appear disabled.
 *
 * Placed persistently in `remote-host-view.tsx`, and auto-expanded when the
 * host was just added (the post-add-host prompt).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, FolderSearch, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { AGENT_PROVIDERS, getProvider } from '@shared/core/providers/agent-provider-registry';

type LoadableAgentRow = {
  name: string;
  dir: string;
  switchAgentId: string;
  apiEndpoint: string;
  providerId: AgentProviderId | null;
  providerSource: string;
  alreadyAgent: boolean;
  ownerName: string | null;
  source: 'server' | 'scan';
  endpointMismatch: boolean;
  blockedReason: string | null;
};

const LOAD_AGENTS_QUERY_KEY = 'load-existing-agents';

export function LoadExistingAgentsSection({
  sshHost,
  serverId,
  initiallyOpen = false,
}: {
  sshHost: string;
  serverId: string;
  initiallyOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const queryClient = useQueryClient();

  const discovery = useQuery({
    queryKey: [LOAD_AGENTS_QUERY_KEY, sshHost, serverId],
    queryFn: () => rpc.agents.discoverLoadableAgentsOnHost({ sshHost, serverId }),
    enabled: isOpen,
  });

  // Agents found by manual directory scans (outside the auto-discovery scope).
  const [manualAgents, setManualAgents] = useState<LoadableAgentRow[]>([]);

  const agents: LoadableAgentRow[] = useMemo(() => {
    const auto = discovery.data?.agents ?? [];
    if (manualAgents.length === 0) return auto;
    const seen = new Set(auto.map((a) => `${a.dir}\0${a.name}`));
    return [...auto, ...manualAgents.filter((a) => !seen.has(`${a.dir}\0${a.name}`))];
  }, [discovery.data, manualAgents]);

  // Per-row provider overrides for agents discovered without a provider.
  const [providerOverrides, setProviderOverrides] = useState<Record<string, AgentProviderId>>({});

  const setProviderFor = useCallback((key: string, providerId: AgentProviderId) => {
    setProviderOverrides((prev) => ({ ...prev, [key]: providerId }));
  }, []);

  // Selection state: keys are "dir\0name".
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleAgent = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectableAgents = useMemo(() => agents.filter((a) => !a.blockedReason), [agents]);

  const toggleAll = useCallback(() => {
    if (selected.size === selectableAgents.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableAgents.map((a) => `${a.dir}\0${a.name}`)));
    }
  }, [selectableAgents, selected.size]);

  // Group selected agents by directory for the attach call.
  const selectedByDir = useMemo(() => {
    const byDir = new Map<string, Array<{ name: string; providerId: AgentProviderId }>>();
    for (const key of selected) {
      const agent = agents.find((a) => `${a.dir}\0${a.name}` === key);
      if (!agent) continue;
      const pid = providerOverrides[key] ?? agent.providerId;
      if (!pid) continue;
      if (!byDir.has(agent.dir)) byDir.set(agent.dir, []);
      byDir.get(agent.dir)!.push({ name: agent.name, providerId: pid });
    }
    return byDir;
  }, [selected, agents, providerOverrides]);

  // Whether every selected agent has a provider assigned.
  const allSelectedHaveProvider = useMemo(() => {
    for (const key of selected) {
      const agent = agents.find((a) => `${a.dir}\0${a.name}` === key);
      if (!agent) continue;
      if (!agent.providerId && !providerOverrides[key]) return false;
    }
    return true;
  }, [selected, agents, providerOverrides]);

  const canLoad = selected.size > 0 && allSelectedHaveProvider;

  const loadMutation = useMutation({
    mutationFn: async () => {
      const results: string[] = [];
      for (const [dir, dirAgents] of selectedByDir) {
        const result = await rpc.agents.attachConfiguredAgents({
          sshHost,
          dir,
          serverId,
          agents: dirAgents,
        });
        if (result.success) {
          results.push(...result.data.map((a: { name: string }) => a.name));
        } else {
          const e = result.error;
          const msg =
            'message' in e
              ? e.message
              : e.type === 'switch-agent-not-on-server'
                ? `Agent ${e.agentId} not found on server ${e.serverName}`
                : `Not signed in to server ${e.serverName}`;
          throw new Error(msg);
        }
      }
      return results;
    },
    onSuccess: (names) => {
      toast({
        title: `Loaded ${names.length} agent${names.length === 1 ? '' : 's'}`,
        description: names.join(', '),
      });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: [LOAD_AGENTS_QUERY_KEY, sshHost, serverId] });
    },
    onError: (error) => {
      toast({
        title: 'Failed to load agents',
        description: failureText(error, 'Could not load the selected agents.'),
        variant: 'destructive',
      });
    },
  });

  // Manual directory scan.
  const [manualDir, setManualDir] = useState('');
  const manualScan = useMutation({
    mutationFn: (dir: string) => rpc.agents.discoverLoadableAgentsInDir({ sshHost, dir, serverId }),
    onSuccess: (found) => {
      setManualAgents((prev) => {
        const keys = new Set(prev.map((a) => `${a.dir}\0${a.name}`));
        return [
          ...prev,
          ...found.filter((a: LoadableAgentRow) => !keys.has(`${a.dir}\0${a.name}`)),
        ];
      });
      setManualDir('');
    },
  });

  const providerOptions = AGENT_PROVIDERS.filter((p) => p.detectable !== false);

  return (
    <section className="pt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-3 py-2 text-left"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Label className="cursor-pointer">Load existing agents</Label>
      </button>

      {isOpen && (
        <div className="space-y-3 px-3 pb-2">
          {discovery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner /> Scanning host for configured agents…
            </div>
          ) : discovery.isError ? (
            <p className="text-xs text-destructive">
              {failureText(discovery.error, 'Could not scan the host.')}
            </p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              No unclaimed agents found on this host. Use "Scan a directory" below if the agent is
              outside <code>$HOME</code>.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-xs text-foreground-muted hover:text-foreground"
                  onClick={toggleAll}
                >
                  {selected.size === selectableAgents.length ? 'Deselect all' : 'Select all'}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={discovery.isFetching}
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: [LOAD_AGENTS_QUERY_KEY, sshHost, serverId],
                    })
                  }
                >
                  <RefreshCw className={`size-3 ${discovery.isFetching ? 'animate-spin' : ''}`} />
                  Rescan
                </Button>
              </div>

              <div className="divide-y divide-border rounded-md border">
                {agents.map((agent) => {
                  const key = `${agent.dir}\0${agent.name}`;
                  const blocked = !!agent.blockedReason;
                  const needsProvider = !agent.providerId && !providerOverrides[key];
                  const isSelected = selected.has(key);

                  return (
                    <div key={key} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={isSelected}
                        disabled={blocked}
                        onCheckedChange={() => toggleAgent(key)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          {agent.blockedReason && (
                            <span className="shrink-0 text-xs text-destructive">
                              {agent.blockedReason}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-foreground-muted">
                          <span className="truncate">{agent.dir}</span>
                          {agent.ownerName && <span>· by {agent.ownerName}</span>}
                          {agent.providerId && (
                            <span>· {getProvider(agent.providerId)?.name ?? agent.providerId}</span>
                          )}
                        </div>
                        {!blocked && agent.ownerName && (
                          <p className="text-xs text-foreground-muted">
                            Session access: yes · rooms: policy admits only its owner, ask{' '}
                            {agent.ownerName} to widen
                          </p>
                        )}
                      </div>
                      {!blocked && needsProvider && (
                        <Select
                          value={providerOverrides[key] ?? ''}
                          onValueChange={(v) => setProviderFor(key, v as AgentProviderId)}
                        >
                          <SelectTrigger className="w-36">
                            <SelectValue placeholder="Provider" />
                          </SelectTrigger>
                          <SelectContent>
                            {providerOptions.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Manual directory scan fallback */}
          <div className="flex items-center gap-2">
            <FolderSearch className="size-4 shrink-0 text-foreground-muted" />
            <Input
              value={manualDir}
              placeholder="Scan a directory (absolute path)"
              className="flex-1"
              onChange={(e) => setManualDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualDir.trim()) manualScan.mutate(manualDir.trim());
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!manualDir.trim() || manualScan.isPending}
              onClick={() => manualScan.mutate(manualDir.trim())}
            >
              {manualScan.isPending ? <Spinner /> : 'Scan'}
            </Button>
          </div>
          {manualScan.isError && (
            <p className="text-xs text-destructive">
              {failureText(manualScan.error, 'Could not scan the directory.')}
            </p>
          )}

          {/* Load button */}
          {agents.length > 0 && (
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!canLoad || loadMutation.isPending}
                onClick={() => loadMutation.mutate()}
              >
                {loadMutation.isPending ? (
                  <>
                    <Spinner /> Loading…
                  </>
                ) : (
                  <>
                    <Download className="size-4" /> Load {selected.size} agent
                    {selected.size === 1 ? '' : 's'}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
