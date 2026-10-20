import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import type { Agent } from '@shared/core/agents/agents';
import { SettingRow } from './setting-row';

type PermissionSetting = 'autoApprove' | 'autoMode';

/** What the two permission rows say, wherever they are shown. */
export const PERMISSION_COPY = {
  autoMode: {
    title: 'Auto mode',
    description: 'Safe actions run on their own; risky ones ask you first.',
    overridden: 'Bypass permissions is on and overrides it.',
    infoLabel: 'More info about auto mode',
    info: "The agent's provider reviews each action before it runs: Claude, Codex, OpenCode and Cursor use their own automatic review, and Antigravity approves edits and asks before commands. Applies to every session, including ones started automatically.",
  },
  autoApprove: {
    title: 'Bypass permissions',
    description: 'Unsafe: every action runs without asking. Overrides auto mode.',
    infoLabel: 'More info about bypassing permissions',
    info: "Sessions start with the provider's auto-approve flag, including ones started automatically. Turn it on only for agents you trust to run unattended.",
  },
} as const;

/** The "Unsafe" mark beside the bypass title. */
export function UnsafeBadge() {
  return <Badge variant="destructive">Unsafe</Badge>;
}

/**
 * Per-agent permission settings: auto mode (the provider's own automatic
 * review) and bypass permissions (no checks at all, winning over auto mode).
 * Both apply to every session, including automation-started ones. The values
 * live on the agent row; each toggle writes through `setAgentPermission`, which
 * also pushes the change to a remote agent's watcher so it takes effect live
 * (CHOO-1664).
 */
export function PermissionSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent (e.g. a subagent's own row); omit for every agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const list = (agents ?? []).filter((a) => !agentId || a.id === agentId);
  if (list.length === 0) return null;
  // Single-agent locations don't need the (directory-derived) agent name label —
  // the section title identifies the setting, so the toggle sits inline with it.
  const single = list.length === 1 ? list[0] : null;

  const perAgent = (setting: PermissionSetting) =>
    !single && (
      <div className="flex flex-col gap-2">
        {list.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
          >
            <span className="truncate text-sm">{agent.name}</span>
            <PermissionSwitch agent={agent} setting={setting} locationId={locationId} />
          </div>
        ))}
      </div>
    );

  return (
    <>
      <AutoModeRow
        overridden={single?.autoApprove ?? false}
        control={
          single && <PermissionSwitch agent={single} setting="autoMode" locationId={locationId} />
        }
      >
        {perAgent('autoMode')}
      </AutoModeRow>
      <AutoApproveRow
        control={
          single && (
            <PermissionSwitch agent={single} setting="autoApprove" locationId={locationId} />
          )
        }
      >
        {perAgent('autoApprove')}
      </AutoApproveRow>
    </>
  );
}

/** The "Auto mode" row itself, whatever holds the value its switch shows. */
export function AutoModeRow({
  overridden,
  control,
  children,
}: {
  /** Bypass is on, so auto mode has no effect for now. */
  overridden: boolean;
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  const copy = PERMISSION_COPY.autoMode;
  return (
    <SettingRow
      title={copy.title}
      info={{ label: copy.infoLabel, content: copy.info }}
      description={overridden ? `${copy.description} ${copy.overridden}` : copy.description}
      control={control}
    >
      {children}
    </SettingRow>
  );
}

/** The "Bypass permissions" row itself, whatever holds the value its switch shows. */
export function AutoApproveRow({
  control,
  children,
}: {
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  const copy = PERMISSION_COPY.autoApprove;
  return (
    <SettingRow
      title={
        <>
          {copy.title}
          <UnsafeBadge />
        </>
      }
      info={{ label: copy.infoLabel, content: copy.info }}
      description={copy.description}
      control={control}
    >
      {children}
    </SettingRow>
  );
}

function PermissionSwitch({
  agent,
  setting,
  locationId,
}: {
  agent: Agent;
  setting: PermissionSetting;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      rpc.agents.setAgentPermission({ agentId: agent.id, setting, enabled: next }),
    onError: (error) => {
      log.error('Failed to update a permission setting for agent', {
        agentId: agent.id,
        setting,
        error,
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <Switch
      aria-label={PERMISSION_COPY[setting].title}
      checked={agent[setting]}
      disabled={mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
