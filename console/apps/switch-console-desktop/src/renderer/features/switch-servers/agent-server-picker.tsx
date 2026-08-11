import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { cn } from '@renderer/utils/utils';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

/** Verification phase the picker reports up so a parent can gate submission. */
export type ServerVerifyState = 'idle' | 'checking' | AgentVerifyResult;

interface AgentServerPickerProps {
  /** The Switch agent id to verify against the chosen server. */
  switchAgentId: string;
  serverId: string | null;
  onServerIdChange: (serverId: string) => void;
  /** Called whenever the verification phase changes (idle while no server). */
  onVerifyStateChange: (state: ServerVerifyState) => void;
  /** Render the server as a fixed read-out (no dropdown) — used when the agent
   * binds to the active server and the choice is not the user's to make. The
   * agent is still verified against it. */
  locked?: boolean;
}

/**
 * A server selector that, once a server is chosen, verifies the agent actually
 * exists on it (`GET /gateway/agents/{id}`) and shows the result inline. Used
 * when onboarding a new agent. When `locked`, the server is fixed (the active
 * server) and shown read-only — every agent must be bound to a server it
 * provably belongs to.
 */
export const AgentServerPicker = observer(function AgentServerPicker({
  switchAgentId,
  serverId,
  onServerIdChange,
  onVerifyStateChange,
  locked = false,
}: AgentServerPickerProps) {
  useEffect(() => {
    if (switchServersStore.servers.length === 0) void switchServersStore.init();
  }, []);

  const servers = switchServersStore.servers;

  const verifyQuery = useQuery({
    queryKey: ['verifyAgent', serverId, switchAgentId],
    queryFn: () => rpc.switchServers.verifyAgent({ serverId: serverId!, agentId: switchAgentId }),
    enabled: !!serverId && !!switchAgentId,
  });

  const state: ServerVerifyState = !serverId
    ? 'idle'
    : verifyQuery.isPending
      ? 'checking'
      : (verifyQuery.data ?? 'checking');

  useEffect(() => {
    onVerifyStateChange(state);
  }, [state, onVerifyStateChange]);

  const serverName = servers.find((s) => s.id === serverId)?.name ?? 'this server';

  return (
    <div className="flex flex-col gap-2">
      {locked ? (
        <div className="rounded-md border border-border bg-background-1 px-3 py-1.5 text-sm">
          {serverId ? serverName : 'No server selected'}
        </div>
      ) : (
        <Select
          value={serverId ?? undefined}
          onValueChange={(next) => {
            if (next) onServerIdChange(next);
          }}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={servers.length === 0 ? 'No servers registered' : 'Select a server'}
            >
              {serverId ? (servers.find((s) => s.id === serverId)?.name ?? serverId) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {servers.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                {server.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {state !== 'idle' && <VerifyStatus state={state} serverName={serverName} />}
    </div>
  );
});

function VerifyStatus({ state, serverName }: { state: ServerVerifyState; serverName: string }) {
  if (state === 'checking') {
    return (
      <Row icon={<Loader2 className="size-3.5 animate-spin text-foreground-muted" />}>
        Checking the agent on {serverName}…
      </Row>
    );
  }
  if (state === 'found') {
    return (
      <Row icon={<CheckCircle2 className="size-3.5 text-green-500" />}>
        Agent found on {serverName}
      </Row>
    );
  }
  if (state === 'unauthenticated') {
    return (
      <Row icon={<CircleAlert className="size-3.5 text-amber-500" />}>
        You're not signed in to {serverName}. Sign in to it, then try again.
      </Row>
    );
  }
  return (
    <Row icon={<CircleAlert className="size-3.5 text-amber-500" />}>
      This agent isn't registered on {serverName}. Pick the server it belongs to.
    </Row>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-2 text-xs text-foreground-muted')}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
