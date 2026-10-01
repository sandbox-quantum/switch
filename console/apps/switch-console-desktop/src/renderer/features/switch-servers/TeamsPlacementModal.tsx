import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type {
  AddTeamsTeamResult,
  RemoveTeamsTeamResult,
  TeamsTeam,
  TeamsTeamsResult,
  UpdateBridgeResult,
} from '@shared/core/switch-servers/switch-servers';

type TeamsPlacementModalArgs = {
  workspaceId: string;
  bridgeId: string;
  bridgeDisplayName: string;
};

type Props = BaseModalProps<void> & TeamsPlacementModalArgs;

const QUERY_KEY = (workspaceId: string, bridgeId: string) => [
  'bridge-teams',
  workspaceId,
  bridgeId,
];

/**
 * Where Switch's distributed Microsoft Teams app is placed: which teams it can
 * see, whether it is in each one, and which is the default for new rooms.
 *
 * Offered only for a connection `team_placement_supported` already says is a
 * running distributed Teams bridge, so every failure case here is either a
 * transient one (the bridge just stopped) or Microsoft Graph itself declining
 * — never "this bridge does not support teams", which the caller has already
 * ruled out before opening this.
 */
export const TeamsPlacementModal = observer(function TeamsPlacementModal({
  workspaceId,
  bridgeId,
  bridgeDisplayName,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = QUERY_KEY(workspaceId, bridgeId);

  const teamsQuery = useQuery({
    queryKey,
    queryFn: () => rpc.workspaces.listBridgeTeams({ workspaceId, bridgeId }),
  });

  const [mutatingTeamId, setMutatingTeamId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingPackage, setSavingPackage] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const refreshBridges = () =>
    queryClient.invalidateQueries({ queryKey: ['remote-bridges', workspaceId] });

  const handleAdd = async (team: TeamsTeam) => {
    setMutatingTeamId(team.teamId);
    setActionError(null);
    try {
      const result = await rpc.workspaces.addBridgeTeam({
        workspaceId,
        bridgeId,
        teamId: team.teamId,
      });
      if (result.kind !== 'added') {
        setActionError(addTeamFailureText(result));
        return;
      }
      await refresh();
    } catch (cause) {
      setActionError(failureText(cause, `Could not add Switch to ${team.name}.`));
    } finally {
      setMutatingTeamId(null);
    }
  };

  const handleRemove = async (team: TeamsTeam) => {
    setMutatingTeamId(team.teamId);
    setActionError(null);
    try {
      const result = await rpc.workspaces.removeBridgeTeam({
        workspaceId,
        bridgeId,
        teamId: team.teamId,
      });
      if (result.kind !== 'removed') {
        setActionError(removeTeamFailureText(result));
        return;
      }
      // Removing Switch from the connection's current default team clears the
      // default and turns channel creation off on the server, restarting the
      // bridge — the same side effect making a team the default has, so the
      // bridge list needs the same refresh.
      await Promise.all([refresh(), refreshBridges()]);
    } catch (cause) {
      setActionError(failureText(cause, `Could not remove Switch from ${team.name}.`));
    } finally {
      setMutatingTeamId(null);
    }
  };

  const handleMakeDefault = async (team: TeamsTeam) => {
    setMutatingTeamId(team.teamId);
    setActionError(null);
    try {
      const result = await rpc.workspaces.setDefaultTeamsTeam({
        workspaceId,
        bridgeId,
        teamId: team.teamId,
      });
      if (result.kind !== 'updated') {
        setActionError(setDefaultFailureText(result));
        return;
      }
      await Promise.all([refresh(), refreshBridges()]);
    } catch (cause) {
      setActionError(failureText(cause, `Could not make ${team.name} the default.`));
    } finally {
      setMutatingTeamId(null);
    }
  };

  const handleSavePackage = async () => {
    setSavingPackage(true);
    setActionError(null);
    try {
      const safeName = bridgeDisplayName.trim().replace(/[^\w.-]+/g, '-') || 'switch-teams-app';
      const path = await rpc.workspaces.downloadTeamsPackage({
        workspaceId,
        bridgeId,
        defaultFileName: `${safeName}.zip`,
      });
      if (path !== null) {
        toast({ title: 'Package saved', description: path });
      }
    } catch (cause) {
      setActionError(failureText(cause, 'Could not save the Teams app package.'));
    } finally {
      setSavingPackage(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Microsoft Teams teams for {bridgeDisplayName}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-4">
          <p className="text-xs text-foreground-muted">
            Choose which teams Switch is added to, and which one new rooms land in by default.
          </p>

          <TeamsPlacementBody
            result={teamsQuery.data ?? null}
            isLoading={teamsQuery.isLoading}
            fetchError={teamsQuery.error}
            mutatingTeamId={mutatingTeamId}
            savingPackage={savingPackage}
            onAdd={(team) => void handleAdd(team)}
            onRemove={(team) => void handleRemove(team)}
            onMakeDefault={(team) => void handleMakeDefault(team)}
            onSavePackage={() => void handleSavePackage()}
          />

          {actionError && <p className="text-xs text-destructive">{actionError}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter>
        {/* An add/remove/make-default or package save in flight has its own
          error to show on failure; closing mid-request would lose it. */}
        <Button
          variant="outline"
          onClick={onClose}
          disabled={mutatingTeamId !== null || savingPackage}
        >
          Close
        </Button>
      </DialogFooter>
    </>
  );
});

function TeamsPlacementBody({
  result,
  isLoading,
  fetchError,
  mutatingTeamId,
  savingPackage,
  onAdd,
  onRemove,
  onMakeDefault,
  onSavePackage,
}: {
  result: TeamsTeamsResult | null;
  isLoading: boolean;
  fetchError: unknown;
  mutatingTeamId: string | null;
  savingPackage: boolean;
  onAdd: (team: TeamsTeam) => void;
  onRemove: (team: TeamsTeam) => void;
  onMakeDefault: (team: TeamsTeam) => void;
  onSavePackage: () => void;
}) {
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-muted">
        <Spinner className="size-3.5" />
        Loading teams…
      </p>
    );
  }
  if (fetchError) {
    return (
      <p className="text-xs text-destructive">
        {failureText(fetchError, 'Could not read this connection’s teams.')}
      </p>
    );
  }
  if (result === null) return null;
  if (result.kind !== 'listed') {
    return <p className="text-xs text-destructive">{teamsResultFailureText(result)}</p>;
  }

  const pending = mutatingTeamId !== null;
  // `catalogProblem` is only ever populated once the server has a reason to
  // give; `inCatalog === false` with no problem yet is still a real state
  // (nothing has tried to catalogue the app), so this is a fact about Switch
  // rather than an empty hole where the server's sentence would go.
  const catalogProblemText =
    result.catalogProblem ?? 'Switch is not in your organisation’s Teams app list yet.';

  return (
    <div className="flex flex-col gap-3">
      {!result.inCatalog && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <div className="flex flex-col gap-1.5">
            <span>{catalogProblemText}</span>
            <span>
              A Teams admin uploads this app in the Teams admin center, under Teams apps → Manage
              apps → Upload new app.
            </span>
            <Button
              variant="outline"
              size="xs"
              className="w-fit"
              disabled={savingPackage}
              onClick={onSavePackage}
            >
              {savingPackage ? 'Saving…' : 'Save Teams app package'}
            </Button>
          </div>
        </div>
      )}

      {result.teams.length === 0 ? (
        <p className="text-xs text-foreground-muted">
          Switch cannot see any teams in this organisation yet.
        </p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {result.teams.map((team) => (
            <li
              key={team.teamId}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-foreground">{team.name}</span>
                {team.isDefault && <Badge variant="secondary">Default</Badge>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {team.hasSwitch === null ? (
                  <span className="text-xs text-foreground-muted">
                    Switch could not read this team’s apps
                  </span>
                ) : team.hasSwitch ? (
                  <>
                    {!team.isDefault && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => onMakeDefault(team)}
                      >
                        {mutatingTeamId === team.teamId ? 'Saving…' : 'Make default'}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => onRemove(team)}
                    >
                      {mutatingTeamId === team.teamId ? 'Removing…' : 'Remove'}
                    </Button>
                  </>
                ) : result.inCatalog ? (
                  <Button size="sm" disabled={pending} onClick={() => onAdd(team)}>
                    {mutatingTeamId === team.teamId ? 'Adding…' : 'Add'}
                  </Button>
                ) : (
                  // A disabled button gets `pointer-events-none`, so it never
                  // fires the hover/focus that would open a tooltip wrapped
                  // directly around it — the span catches those instead.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span tabIndex={0} aria-label={catalogProblemText} className="inline-flex">
                          <Button size="sm" disabled>
                            Add
                          </Button>
                        </span>
                      }
                    />
                    <TooltipContent className="max-w-xs">{catalogProblemText}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Turn a result other than `listed` into something the user can act on. */
function teamsResultFailureText(result: Exclude<TeamsTeamsResult, { kind: 'listed' }>): string {
  switch (result.kind) {
    case 'not-distributed-teams':
      return 'This connection no longer supports Microsoft Teams team placement.';
    case 'not-running':
      return result.message;
    case 'microsoft-refused':
      return result.message;
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Managing teams requires an owner or admin of this workspace.';
    case 'error':
      return result.message;
  }
}

function addTeamFailureText(result: Exclude<AddTeamsTeamResult, { kind: 'added' }>): string {
  switch (result.kind) {
    case 'not-in-catalog':
      return result.message;
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Managing teams requires an owner or admin of this workspace.';
    case 'error':
      return result.message;
  }
}

function removeTeamFailureText(
  result: Exclude<RemoveTeamsTeamResult, { kind: 'removed' }>
): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Managing teams requires an owner or admin of this workspace.';
    case 'error':
      return result.message;
  }
}

function setDefaultFailureText(result: Exclude<UpdateBridgeResult, { kind: 'updated' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Managing teams requires an owner or admin of this workspace.';
    case 'invalid':
      return result.message;
    case 'error':
      return result.message;
  }
}
