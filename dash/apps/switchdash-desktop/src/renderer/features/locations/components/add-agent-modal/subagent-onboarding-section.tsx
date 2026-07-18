import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { useAgent } from '@renderer/lib/stores/use-agents';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type SubagentSelection = { name: string; description: string }[];

/** Where to discover subagent definitions: a local location dir, or a remote
 * agent's working dir on its SSH host (scanned over SFTP during onboarding). */
export type SubagentOnboardingSource =
  | { kind: 'local'; dir: string }
  | { kind: 'remote'; sshHost: string; remoteRepoDir: string };

/**
 * Lists the agent's subagents in the Add Agent modal and lets the user pick
 * which not-yet-registered, Switch-eligible ones to onboard alongside the parent.
 * Already-registered ones are shown as done; ineligible ones (no Switch tool
 * access) are shown disabled. Reports the current selection to the parent via
 * `onSelectionChange`. Renders nothing for agent types with no subagents
 * capability. Works for both local and remote (SSH) agents.
 */
export function SubagentOnboardingSection({
  source,
  providerId,
  onSelectionChange,
}: {
  source: SubagentOnboardingSource;
  providerId: AgentProviderId | null;
  onSelectionChange: (selection: SubagentSelection) => void;
}) {
  const { data: agent } = useAgent(providerId ?? '');
  const supportsSubagents = !!providerId && agent?.capabilities.subagents.kind !== 'none';

  const sourceReady =
    source.kind === 'local'
      ? source.dir.length > 0
      : source.sshHost.length > 0 && source.remoteRepoDir.length > 0;
  const sourceKey =
    source.kind === 'local' ? source.dir : `${source.sshHost}:${source.remoteRepoDir}`;

  const defsQuery = useQuery({
    queryKey: ['subagentDefs', source.kind, sourceKey, providerId],
    queryFn: () =>
      source.kind === 'local'
        ? rpc.subagents.listDefinitions({ dir: source.dir, providerId: providerId! })
        : rpc.subagents.listRemoteDefinitions({
            sshHost: source.sshHost,
            remoteRepoDir: source.remoteRepoDir,
            providerId: providerId!,
          }),
    enabled: sourceReady && supportsSubagents,
  });
  const defs = useMemo(() => defsQuery.data ?? [], [defsQuery.data]);
  const onboardable = useMemo(() => defs.filter((d) => d.eligible && !d.registered), [defs]);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Default to selecting every onboardable subagent. `onboardable` is memoized
  // on the query data, so this re-inits only when the discovered set actually
  // changes (e.g. the user picks a different directory).
  useEffect(() => {
    setSelected(new Set(onboardable.map((d) => d.name)));
  }, [onboardable]);

  useEffect(() => {
    onSelectionChange(
      onboardable
        .filter((d) => selected.has(d.name))
        .map((d) => ({ name: d.name, description: d.description ?? '' }))
    );
  }, [selected, onboardable, onSelectionChange]);

  const toggle = useCallback((name: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  if (defs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground-muted">
        Subagents ({onboardable.length} to onboard)
      </span>
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-background-1 p-1">
        {defs.map((def) => {
          const canSelect = def.eligible && !def.registered;
          return (
            <div key={def.name} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
              {def.registered ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<CheckCircle2 className="size-4 shrink-0 text-green-500" />}
                  />
                  <TooltipContent>Already registered on the server</TooltipContent>
                </Tooltip>
              ) : (
                <Checkbox
                  checked={canSelect && selected.has(def.name)}
                  disabled={!canSelect}
                  onCheckedChange={(checked) => toggle(def.name, checked === true)}
                  aria-label={`Onboard subagent ${def.name}`}
                />
              )}
              <span className="min-w-0 flex-1 truncate" title={def.description ?? undefined}>
                {def.name}
              </span>
              {!def.eligible && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="shrink-0 rounded bg-background-2 px-1 text-[10px] text-foreground-muted">
                        no Switch access
                      </span>
                    }
                  />
                  <TooltipContent>
                    This subagent's tools don't include the Switch MCP server, so it can't
                    participate in Switch rooms.
                  </TooltipContent>
                </Tooltip>
              )}
              {def.registered && (
                <span className="shrink-0 text-[10px] text-foreground-muted">registered</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
