import React, { useMemo, useState } from 'react';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { Label } from '@renderer/lib/ui/label';
import { AgentDetailSheet } from './AgentDetailSheet';
import { AgentRow } from './AgentRow';

const SectionLabel: React.FC<{ children: React.ReactNode; totalCount: number }> = ({
  children,
  totalCount,
}) => (
  <div className="px-3 py-2">
    <Label>
      {children}
      {` (${totalCount})`}
    </Label>
  </div>
);

export type AgentFilter = 'all' | 'installed' | 'uninstalled';

type CliAgentsListProps = {
  searchQuery?: string;
  filter?: AgentFilter;
  onFilterChange?: (filter: AgentFilter) => void;
};

export const CliAgentsList: React.FC<CliAgentsListProps> = ({
  searchQuery = '',
  filter = 'all',
}) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { data: agentPayloads } = useAgents();
  const normalizedQuery = searchQuery.toLowerCase();

  const allAgents = useMemo(
    () =>
      (agentPayloads ?? [])
        // Only Switch-supported agent types are shown for now; the others aren't
        // usable in Switch yet, so surfacing them here would be misleading.
        .filter((a) => a.capabilities.switchSetup.kind !== 'none')
        .filter((a) => !normalizedQuery || a.name.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agentPayloads, normalizedQuery]
  );

  const installed = useMemo(() => allAgents.filter((a) => a.status === 'available'), [allAgents]);

  const uninstalled = useMemo(() => allAgents.filter((a) => a.status !== 'available'), [allAgents]);

  const visible =
    filter === 'installed' ? installed : filter === 'uninstalled' ? uninstalled : allAgents;

  const sectionLabel =
    filter === 'installed'
      ? 'Installed'
      : filter === 'uninstalled'
        ? 'Not installed'
        : 'All agents';

  return (
    <div className="pb-4">
      {visible.length > 0 && (
        <div className="pt-4">
          <SectionLabel totalCount={visible.length}>{sectionLabel}</SectionLabel>
          {visible.map((agent) => (
            <div key={agent.id} className="w-full py-0.5">
              <AgentRow agent={agent} onClick={() => setSelectedAgentId(agent.id)} />
            </div>
          ))}
        </div>
      )}
      <AgentDetailSheet agentId={selectedAgentId} onClose={() => setSelectedAgentId(null)} />
    </div>
  );
};
