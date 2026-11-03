import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { cn } from '@renderer/utils/utils';
import type { CliConversation, CliConversationList } from '@shared/core/sessions/cli-conversations';

/**
 * The conversations started in Claude Code's own CLI in an agent's folder, read
 * on the machine its sessions run on. Not asked for when `agentId` is null.
 */
export function useCliConversations(agentId: string | null): {
  list: CliConversationList | null;
  loading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: ['cliConversations', agentId],
    queryFn: () => rpc.sessions.listCliConversations(agentId!),
    enabled: agentId !== null,
    // Read afresh each time the dialog opens, since whether a terminal has one
    // open changes from minute to minute, but not on every return to the
    // window: each read runs on the agent's host. The copy checks again.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const result = query.data;
  return {
    list: result?.success ? result.data : null,
    loading: query.isLoading,
    error: query.error
      ? failureText(query.error, 'Could not list the agent’s Claude Code conversations.')
      : result && !result.success
        ? result.error.message
        : null,
  };
}

const TRIGGER =
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none';

function openInLabel(openIn: NonNullable<CliConversation['openIn']>): string {
  const where = openIn.entrypoint === 'claude-vscode' ? 'VS Code' : 'Claude Code';
  return `Open in ${where} (process ${openIn.pid})`;
}

/**
 * Where a Claude Code agent's session starts: a new conversation, or one
 * started in Claude Code's CLI, which the session continues from a copy so the
 * terminal's own is never written to. One a terminal has open cannot be
 * picked; where Claude Code does not record which are open, picking one asks
 * the person to say it is closed.
 */
export function CliConversationField({
  conversations,
  value,
  onChange,
  confirmedClosed,
  onConfirmedClosedChange,
}: {
  conversations: ReturnType<typeof useCliConversations>;
  value: CliConversation | null;
  onChange: (next: CliConversation | null) => void;
  confirmedClosed: boolean;
  onConfirmedClosedChange: (next: boolean) => void;
}) {
  const { list, loading, error } = conversations;
  const items = list?.conversations ?? [];
  return (
    <Field>
      <FieldLabel>Conversation</FieldLabel>
      <Combobox
        items={items}
        value={value}
        onValueChange={(next: CliConversation | null) => {
          onChange(next);
          onConfirmedClosedChange(false);
        }}
        isItemEqualToValue={(a: CliConversation, b: CliConversation) =>
          a.nativeSessionId === b.nativeSessionId
        }
        itemToStringLabel={(item: CliConversation) => item.title}
        filter={(item: CliConversation, query) =>
          item.title.toLowerCase().includes(query.toLowerCase())
        }
        autoHighlight
      >
        <ComboboxTrigger
          disabled={loading || items.length === 0}
          className={cn(
            TRIGGER,
            (loading || items.length === 0) && 'cursor-not-allowed opacity-60'
          )}
        >
          <span className={cn('flex-1 truncate text-left', !value && 'text-foreground-muted')}>
            {value ? value.title : loading ? 'Looking for CLI conversations…' : 'New conversation'}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
        </ComboboxTrigger>
        <ComboboxContent className="min-w-(--anchor-width)">
          <ComboboxInput showTrigger={false} placeholder="Search conversations…" />
          <ComboboxList>
            {(item: CliConversation) => (
              <ComboboxItem key={item.nativeSessionId} value={item} disabled={item.openIn !== null}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.title}</span>
                  <span className="truncate text-xs text-foreground-muted">
                    {item.openIn ? (
                      openInLabel(item.openIn)
                    ) : (
                      <>
                        <RelativeTime value={item.lastActivityAt} />
                        {item.gitBranch && ` · ${item.gitBranch}`}
                      </>
                    )}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>No conversations found</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      {value && (
        <button
          type="button"
          className="mt-1 self-start text-xs text-foreground-muted underline-offset-2 hover:underline"
          onClick={() => {
            onChange(null);
            onConfirmedClosedChange(false);
          }}
        >
          Start a new conversation instead
        </button>
      )}
      <p className="mt-1 text-xs text-foreground-muted">
        {error
          ? error
          : value
            ? 'The session continues a copy of this conversation and shows what was said in it. The original in Claude Code stays as it was.'
            : !loading && items.length === 0
              ? 'No conversations started in the Claude Code CLI in this agent’s folder.'
              : 'Or continue a conversation started in the Claude Code CLI in this agent’s folder.'}
      </p>
      {value && list && !list.ownershipKnown && (
        <label className="group/field mt-2 flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={confirmedClosed}
            onCheckedChange={(checked) => onConfirmedClosedChange(checked === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">It isn’t open in a terminal</span>
            <span className="text-xs text-foreground-muted">
              This version of Claude Code doesn’t record which conversations are open, so Console
              can’t check. Close it in the terminal first.
            </span>
          </span>
        </label>
      )}
    </Field>
  );
}
