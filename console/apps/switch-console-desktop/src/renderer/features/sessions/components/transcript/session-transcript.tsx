import { ArrowDown, Loader2, Square } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsActiveSession } from '@renderer/features/sessions/hooks/use-is-active-session';
import {
  useSessionViewContext,
  useSessionViewModel,
} from '@renderer/features/sessions/session-view-context';
import { sessionTranscriptRegistry } from '@renderer/features/sessions/stores/session-transcript-registry';
import type { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { TranscriptSessionState } from '@shared/core/sessions/session-transcript';
import { ActivityGroup } from './activity-row';
import { ApprovalCard } from './approval-card';
import { QuestionCard } from './question-card';
import { TranscriptComposer } from './transcript-composer';
import { AssistantMessage, NoticeRow, UserMessage } from './transcript-messages';
import { buildTranscriptSections } from './transcript-sections';

const STATE_LABELS: Record<TranscriptSessionState, string> = {
  starting: 'Starting',
  ready: 'Ready',
  running: 'Working',
  stopped: 'Stopped',
  error: 'Error',
};

const STATE_DOT: Record<TranscriptSessionState, string> = {
  starting: 'bg-foreground-passive',
  ready: 'bg-foreground-success',
  running: 'bg-foreground-info',
  stopped: 'bg-foreground-passive',
  error: 'bg-foreground-destructive',
};

/** How close to the bottom still counts as "at the bottom", in pixels. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * The whole view for a provider-backed session: a scrolling transcript with a
 * sticky composer, in place of the terminal a `pty` session gets.
 *
 * The transcript follows the bottom only while the reader is already there —
 * scrolling up to read something is a decision, and yanking the view back on
 * the next token undoes it. The pill offers the way back.
 */
export const SessionTranscript = observer(function SessionTranscript() {
  const { sessionId } = useSessionViewContext();
  const sessionView = useSessionViewModel();
  const isActive = useIsActiveSession(sessionId);

  const store = useMemo(() => sessionTranscriptRegistry.acquire(sessionId), [sessionId]);
  useEffect(() => () => sessionTranscriptRegistry.release(sessionId), [sessionId]);

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
      onFocus={() => {
        if (isActive) sessionView.setFocusedRegion('main');
      }}
    >
      <TranscriptHeader store={store} />
      <TranscriptScroller store={store} />
      <TranscriptComposer
        store={store}
        autoFocus={isActive && sessionView.focusedRegion === 'main'}
      />
    </div>
  );
});

const TranscriptHeader = observer(function TranscriptHeader({
  store,
}: {
  store: SessionTranscriptStore;
}) {
  const [interrupting, setInterrupting] = useState(false);

  const interrupt = async () => {
    setInterrupting(true);
    try {
      await store.interrupt();
    } catch (error) {
      log.error('Failed to interrupt a turn', { error });
      const { headline, detail } = describeFailure(error, 'Could not stop the turn.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setInterrupting(false);
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[store.state])} />
      <span className="text-tiny tracking-wide text-foreground-muted uppercase">
        {STATE_LABELS[store.state]}
      </span>
      {store.pendingInputs.length > 0 && (
        <span className="text-tiny text-foreground-warning">
          {store.pendingInputs.length === 1
            ? '1 item needs an answer'
            : `${store.pendingInputs.length} items need an answer`}
        </span>
      )}
      <div className="flex-1" />
      {store.isRunning && (
        <Button
          size="xs"
          variant="outline"
          disabled={interrupting}
          onClick={() => void interrupt()}
        >
          {interrupting ? <Loader2 className="animate-spin" /> : <Square />}
          Stop
        </Button>
      )}
    </div>
  );
});

const TranscriptScroller = observer(function TranscriptScroller({
  store,
}: {
  store: SessionTranscriptStore;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const entries = store.entries;
  const sections = useMemo(
    () => buildTranscriptSections(entries, store.turns),
    [entries, store.turns]
  );

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance <= FOLLOW_THRESHOLD_PX);
  }, []);

  // Follow new content only while the reader is already at the bottom. Keyed on
  // the entry count and the last entry's text so a streaming reply keeps the
  // view pinned without a subscription to every entry in the list.
  const lastEntry = entries.at(-1);
  const followKey = `${entries.length}:${lastEntry && 'text' in lastEntry ? lastEntry.text.length : 0}`;
  useEffect(() => {
    if (!atBottom) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [followKey, atBottom]);

  if (store.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-foreground-muted" />
      </div>
    );
  }

  if (store.error) {
    return (
      <div className="flex-1">
        <EmptyState label="Could not read the transcript" description={store.error} />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-3">
        {entries.length === 0 ? (
          <EmptyState
            label="No messages yet"
            description="Send a message to start the conversation. Anything addressed to this agent in a room shows up here too."
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {sections.map((section, index) => (
              <div
                key={`${section.turnId ?? 'no-turn'}-${index}`}
                className="flex flex-col gap-2.5"
                data-turn-status={section.turn?.status}
              >
                {section.blocks.map((block) => {
                  if (block.kind === 'activity') {
                    return <ActivityGroup key={block.id} items={block.items} />;
                  }
                  const entry = block.entry;
                  switch (entry.kind) {
                    case 'user':
                      return <UserMessage key={entry.id} entry={entry} />;
                    case 'assistant':
                      return <AssistantMessage key={entry.id} entry={entry} />;
                    case 'request':
                      return <ApprovalCard key={entry.id} entry={entry} store={store} />;
                    case 'question':
                      return <QuestionCard key={entry.id} entry={entry} store={store} />;
                    case 'notice':
                      return <NoticeRow key={entry.id} entry={entry} />;
                  }
                })}
                {section.turn?.status === 'error' && section.turn.message && (
                  <p className="text-xs text-foreground-destructive">{section.turn.message}</p>
                )}
                {section.turn?.status === 'interrupted' && (
                  <p className="text-xs text-foreground-passive">Interrupted.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {!atBottom && (
        <Button
          size="xs"
          variant="outline"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
        >
          <ArrowDown />
          Jump to latest
        </Button>
      )}
    </div>
  );
});
