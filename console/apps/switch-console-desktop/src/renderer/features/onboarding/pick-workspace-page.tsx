import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { onboardingStore } from './onboarding-store';

/**
 * Which of the server's workspaces the window should be scoped to.
 *
 * The page asks the server rather than reading the list this app already holds:
 * signing in is the first moment the gateway will say what the account is a
 * member of, and an install that has been sitting on the sign-in form is
 * answering from before that.
 *
 * Only memberships are offered. The design also shows workspaces open to you
 * because your email domain matches, and invitations waiting for your address —
 * both are **absent here rather than empty**, because a Switch server cannot
 * answer for either yet: it records no email domain against a workspace and has
 * no way to list the invitations sent to an address. An empty "nobody has
 * invited you" section would be a claim the server never made, and one that
 * will read as false to the first person who was in fact invited.
 */
export const PickWorkspacePage = observer(function PickWorkspacePage({
  server,
  onBack,
  onPicked,
  onCreate,
}: {
  server: SwitchServer;
  onBack: () => void;
  onPicked: () => void;
  onCreate: () => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['onboarding-workspaces', server.id],
    queryFn: () => rpc.switchServers.resolveWorkspaces(server.id),
  });
  const workspaces = query.data ?? null;

  const open = useCallback(
    async (workspace: Workspace) => {
      setOpening(workspace.id);
      setOpenError(null);
      try {
        await workspacesStore.setActive(workspace.id);
        onPicked();
      } catch (cause) {
        setOpenError(failureText(cause, `Could not open ${workspace.name}.`));
        setOpening(null);
      }
    },
    [onPicked]
  );

  // Once per answer, not once per render: the callbacks are made fresh by the
  // page above, so without the latch a re-render would re-run the choice that
  // is already under way.
  const settled = useRef(false);
  useEffect(() => {
    if (workspaces === null || settled.current) return;
    settled.current = true;
    onboardingStore.resolved(workspaces);
    // A question with one answer is not a question, and with none there is
    // nothing here to answer it with.
    if (workspaces.length === 0) onCreate();
    else if (workspaces.length === 1) void open(workspaces[0]!);
  }, [workspaces, open, onCreate]);

  return (
    <WizardFrame
      title="Pick a workspace"
      subtitle="You’re a member of these. A workspace is where your agents, rooms and teammates live."
      footer={null}
      pager={{ pageName: 'Pick a workspace', onBack, onNext: null }}
    >
      {query.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          Checking which workspaces you’re in…
        </p>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">
            {failureText(query.error, `Could not ask ${server.name} which workspaces you’re in.`)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {(workspaces ?? []).map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                opening={opening === workspace.id}
                disabled={opening !== null}
                onOpen={() => void open(workspace)}
              />
            ))}
          </ul>

          {openError && <p className="text-sm text-destructive">{openError}</p>}

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-foreground-muted">or start fresh</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={onCreate}
            disabled={opening !== null}
            className="flex items-center justify-center gap-2 rounded-[10px] border border-dashed border-border px-3.5 py-3 text-sm font-medium text-foreground hover:bg-[var(--sel-soft)] disabled:opacity-50"
          >
            <Plus className="size-4" />
            Create a new workspace
          </button>
        </div>
      )}
    </WizardFrame>
  );
});

function WorkspaceRow({
  workspace,
  opening,
  disabled,
  onOpen,
}: {
  workspace: Workspace;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="flex w-full items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3 text-left hover:bg-[var(--sel-soft)] disabled:opacity-60"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-sm font-semibold text-foreground">
          {initialOf(workspace.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {workspace.name}
        </span>
        {workspace.role && (
          <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
            {workspace.role}
          </span>
        )}
        {opening ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <span className="shrink-0 text-sm text-foreground-muted">Open</span>
        )}
      </button>
    </li>
  );
}

const GRAPHEMES = new Intl.Segmenter();

/** By grapheme, so a name starting with an emoji is not cut in half. */
function initialOf(name: string): string {
  return ([...GRAPHEMES.segment(name)][0]?.segment ?? '?').toUpperCase();
}
