import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useId } from 'react';
import {
  AddressingPolicyEditor,
  type OptionItem,
} from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import type { ConfigureAgentFormState } from './modes';

/**
 * Create form for a new Switch agent in a directory. Collects the target server,
 * Switch agent name, and description, then the managed-session options
 * (auto-session, bypass permissions, addressing policy). switchdash always
 * registers the agent as a managed, session-addressable identity — there is no
 * run-mode or notify-handle choice (CHOO-1440); advanced definition attributes
 * live in the collapsed Advanced section.
 */
export const ConfigureAgentPanel = observer(function ConfigureAgentPanel({
  form,
  serverId,
  onAddServer,
}: {
  form: ConfigureAgentFormState;
  serverId: string | null;
  onAddServer: () => void;
}) {
  const nameId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (switchServersStore.servers.length === 0) void switchServersStore.init();
  }, []);

  const servers = switchServersStore.servers;

  // Selector data for the addressing-policy editor, scoped to the chosen server.
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId as string),
    enabled: serverId !== null,
  });
  const groupsQuery = useQuery({
    queryKey: ['remote-room-groups', serverId],
    queryFn: () => rpc.switchServers.listRemoteRoomGroups(serverId as string),
    enabled: serverId !== null,
  });
  const usersQuery = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId as string),
    enabled: serverId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId as string),
    enabled: serverId !== null,
  });
  const roomOptions: OptionItem[] = (roomsQuery.data ?? []).map((r) => ({
    id: r.id,
    label: r.name,
  }));
  const groupOptions: OptionItem[] = (groupsQuery.data ?? []).map((g) => ({
    id: g.id,
    label: g.name,
  }));
  const userOptions: OptionItem[] = (usersQuery.data ?? []).map((u) => ({
    id: u.id,
    label: u.username,
  }));
  const agentOptions: OptionItem[] = (agentsQuery.data ?? []).map((a) => ({
    id: a.id,
    label: a.name,
  }));

  if (servers.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span>
            No Switch servers are registered yet. Add the server to register this agent on.
          </span>
          <Button variant="outline" size="sm" className="self-start" onClick={onAddServer}>
            Add a server
          </Button>
        </div>
      </div>
    );
  }

  return (
    <FieldGroup>
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span>
          Create a new agent below — its definition and per-agent credentials are written into this
          directory&apos;s
          <span className="mx-1 font-mono">.claude/agents</span> and
          <span className="mx-1 font-mono">.switch/agents</span>.
        </span>
      </div>

      <Field>
        <FieldLabel>Switch server</FieldLabel>
        <div className="rounded-md border border-border bg-background-1 px-3 py-1.5 text-sm">
          {serverId
            ? (servers.find((s) => s.id === serverId)?.name ?? serverId)
            : 'No server selected'}
        </div>
      </Field>

      <Field>
        <FieldLabel htmlFor={nameId}>Agent name</FieldLabel>
        <Input
          id={nameId}
          placeholder="claude-code.my-repo.me"
          value={form.agentName}
          onChange={(e) => form.setAgentName(e.target.value)}
          aria-invalid={form.agentName.length > 0 && !form.nameIsValid}
        />
        {form.agentName.length > 0 && !form.nameIsValid ? (
          <span className="text-destructive text-xs">
            Use lowercase letters, digits, <span className="font-mono">. - _</span>, starting with a
            letter or digit. No spaces or uppercase.
          </span>
        ) : (
          <span className="text-xs text-foreground-muted">
            Visible to everyone in the agent&apos;s rooms — include your name so it&apos;s clear
            which person&apos;s Claude Code this is.
          </span>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <Input
          id={descriptionId}
          placeholder="Claude Code running in my-repo"
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value)}
        />
      </Field>

      <Field>
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-border px-2 py-1.5">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">Auto-create a session on notify</span>
            <span className="text-xs text-foreground-muted">
              switchdash watches this agent&apos;s rooms and starts a session automatically when
              it&apos;s addressed with none running.
            </span>
          </span>
          <Switch
            className="mt-0.5"
            checked={form.autoSession}
            onCheckedChange={(checked) => form.setAutoSession(checked)}
          />
        </label>
      </Field>

      <Field>
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-border px-2 py-1.5">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">Bypass permissions</span>
            <span className="text-xs text-foreground-muted">
              Start this agent&apos;s sessions with permission prompts bypassed (the provider&apos;s
              auto-approve flag). Turn on only for agents you trust to run unattended.
            </span>
          </span>
          <Switch
            className="mt-0.5"
            checked={form.autoApprove}
            onCheckedChange={(checked) => form.setAutoApprove(checked)}
          />
        </label>
      </Field>

      <Field>
        <FieldLabel>Who can address this agent</FieldLabel>
        <span className="text-xs text-foreground-muted">
          Restrict who may @mention, target, or delegate tasks to the agent. Defaults to open
          (anyone in the room). You can change this later from the agent&apos;s settings.
        </span>
        <AddressingPolicyEditor
          value={form.addressingPolicy}
          onChange={form.setAddressingPolicy}
          rooms={roomOptions}
          roomGroups={groupOptions}
          users={userOptions}
          agents={agentOptions}
        />
      </Field>
    </FieldGroup>
  );
});
