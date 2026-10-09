import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, UserMinus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatFailure } from '../stores/chat-errors';
import { chatsStore } from '../stores/chats';

/**
 * Start a chat with one agent or several: a private room owned by the person,
 * direct with one agent, a channel naming whom each message is for with
 * several. One request id per opening of the dialog, so pressing Create again after a
 * failure that may have landed resumes that chat rather than making another.
 */
export const NewChatModal = observer(function NewChatModal({
  serverId,
  agentId: initialAgentId,
  onSuccess,
  onClose,
}: BaseModalProps<ChatSummary> & { serverId: string; agentId: string | null }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const agents = useWorkspaceAgents(workspaceId);
  const [agentIds, setAgentIds] = useState<string[]>(initialAgentId ? [initialAgentId] : []);
  const toggle = (agentId: string) =>
    setAgentIds((current) =>
      current.includes(agentId) ? current.filter((each) => each !== agentId) : [...current, agentId]
    );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const listed = useMemo(
    () =>
      (agents.data ?? [])
        .filter((agent) =>
          `${agent.displayName ?? ''} ${agent.name}`.toLowerCase().includes(filter.toLowerCase())
        )
        .sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
    [agents.data, filter]
  );
  const create = async () => {
    if (!agentIds.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chat = await rpc.chats.create({
        serverId,
        agentIds,
        name: name.trim() || null,
        requestId,
      });
      chatsStore.add(serverId, chat);
      onSuccess(chat);
    } catch (caught) {
      const failure = chatFailure(caught);
      setError(
        failure.kind === 'other' && failure.uncertain
          ? `${failure.message} Press Create again: it resumes the same chat rather than making another.`
          : failure.message
      );
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>New chat</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Agents</FieldLabel>
            <Input
              placeholder="Find an agent"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              autoFocus={initialAgentId === null}
            />
            <div
              role="listbox"
              aria-label="Agents"
              aria-multiselectable
              className="mt-2 max-h-60 overflow-y-auto rounded-md border border-border"
            >
              {agents.isLoading && (
                <p className="flex items-center gap-2 p-3 text-sm text-foreground-muted">
                  <Loader2 className="size-3.5 animate-spin" /> Loading agents…
                </p>
              )}
              {agents.error && (
                <p role="alert" className="p-3 text-sm text-foreground-destructive">
                  {failureText(agents.error, 'The agents could not be listed.')}
                </p>
              )}
              {listed.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={agentIds.includes(agent.id)}
                  onClick={() => toggle(agent.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--sel-soft)]',
                    agentIds.includes(agent.id) && 'bg-[var(--sel)] font-medium'
                  )}
                >
                  <Check
                    className={cn('size-3.5 shrink-0', !agentIds.includes(agent.id) && 'invisible')}
                  />
                  <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={18} />
                  <span className="min-w-0 truncate">{agent.displayName ?? agent.name}</span>
                  {agent.ownerName && (
                    <span className="ml-auto shrink-0 text-xs text-foreground-muted">
                      {agent.ownerName}
                    </span>
                  )}
                </button>
              ))}
              {agents.data && listed.length === 0 && (
                <p className="p-3 text-sm text-foreground-muted">No agent matches.</p>
              )}
            </div>
            <p className="mt-1 text-xs text-foreground-muted">
              {agentIds.length > 1
                ? `${agentIds.length} agents. In a chat with several, each message names the agent it is for.`
                : 'Pick more than one to bring several agents into the chat.'}
            </p>
          </Field>
          <Field>
            <FieldLabel>Name (optional)</FieldLabel>
            <Input
              value={name}
              placeholder="What is this chat about?"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
              }}
            />
          </Field>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void create()} disabled={!agentIds.length || busy}>
          {busy ? 'Creating…' : 'Create'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

/** Rename a chat: its room's name, for everyone in it. */
export function RenameChatModal({
  serverId,
  roomId,
  currentName,
  onSuccess,
  onClose,
}: BaseModalProps<void> & { serverId: string; roomId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== currentName;
  const rename = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.chats.rename(serverId, roomId, trimmed);
      const chat = chatsStore.chat(roomId);
      if (chat) chatsStore.add(serverId, { ...chat, name: trimmed });
      onSuccess();
    } catch (caught) {
      setError(failureText(caught, 'Could not rename the chat.'));
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename chat</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename();
              }}
            />
            <p className="mt-1 text-xs text-foreground-muted">
              The room is renamed for everyone in it.
            </p>
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void rename()} disabled={!valid || busy}>
          {busy ? 'Renaming…' : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}

/** Who is in the chat; its managers invite workspace members and remove people. */
export const ChatMembersModal = observer(function ChatMembersModal({
  serverId,
  roomId,
  onClose,
}: BaseModalProps<void> & { serverId: string; roomId: string }) {
  const cache = useQueryClient();
  const key = ['chat-members', serverId, roomId];
  const members = useQuery({ queryKey: key, queryFn: () => rpc.chats.members(serverId, roomId) });
  const canManage = chatsStore.chat(roomId)?.canManage ?? false;
  const tenantMembers = useQuery({
    queryKey: ['tenant-members', serverId],
    queryFn: () => rpc.chats.tenantMembers(serverId),
    enabled: canManage,
  });
  const meId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (userId: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(userId);
    setError(null);
    try {
      await action();
      await cache.invalidateQueries({ queryKey: key });
    } catch (caught) {
      setError(failureText(caught, failure));
    } finally {
      setBusy(null);
    }
  };
  const inRoom = new Set((members.data ?? []).map((member) => member.userId));
  const invitable = (tenantMembers.data ?? []).filter((member) => !inRoom.has(member.userId));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Members</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {members.isLoading && <p className="text-sm text-foreground-muted">Loading…</p>}
        {members.error && (
          <p role="alert" className="text-sm text-foreground-destructive">
            {failureText(members.error, 'The members could not be listed.')}
          </p>
        )}
        <ul className="divide-y divide-border rounded-md border border-border">
          {(members.data ?? []).map((member) => (
            <li key={member.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {member.name}
                {member.userId === meId && <span className="text-foreground-muted"> (you)</span>}
              </span>
              {member.isOwner && <span className="text-xs text-foreground-muted">Owner</span>}
              {canManage && !member.isOwner && member.userId !== meId && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`Remove ${member.name}`}
                  title={`Remove ${member.name}`}
                  onClick={() =>
                    void run(
                      member.userId,
                      () => rpc.chats.removeMember(serverId, roomId, member.userId),
                      `Could not remove ${member.name}.`
                    )
                  }
                >
                  {busy === member.userId ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <UserMinus className="size-3.5" />
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground-muted">Invite from this workspace</p>
            {tenantMembers.error && (
              <p role="alert" className="text-sm text-foreground-destructive">
                {failureText(tenantMembers.error, 'The workspace members could not be listed.')}
              </p>
            )}
            {tenantMembers.data && invitable.length === 0 && (
              <p className="text-sm text-foreground-muted">Everyone in the workspace is here.</p>
            )}
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {invitable.map((member) => (
                <li key={member.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{member.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        member.userId,
                        () => rpc.chats.invite(serverId, roomId, member.userId),
                        `Could not invite ${member.name}.`
                      )
                    }
                  >
                    {busy === member.userId ? 'Inviting…' : 'Invite'}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-foreground-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
});
