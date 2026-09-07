import { ArrowUp, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import type { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';
import { log } from '@renderer/utils/logger';
import { composerPlaceholder } from './transcript-inputs';

export const TranscriptComposer = observer(function TranscriptComposer({
  store,
  autoFocus,
}: {
  store: SessionTranscriptStore;
  autoFocus: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const disabled = !store.canSend || sending;

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setSending(true);
    try {
      await store.sendTurn(trimmed);
      setText('');
    } catch (error) {
      log.error('Failed to send a turn', { error });
      const { headline, detail } = describeFailure(error, 'Could not send the message.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="rounded-xl border border-border bg-background-1 p-2 shadow-sm transition-colors focus-within:border-border-primary">
      <Textarea
        ref={ref}
        rows={2}
        value={text}
        disabled={disabled}
        aria-label="Message the agent"
        placeholder={composerPlaceholder(store.state, store.isRunning)}
        className="min-h-16 resize-none border-0 bg-transparent px-2 py-2 leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <span className="text-tiny text-foreground-passive">
          Enter to send · Shift + Enter for a new line
        </span>
        <Button
          size="icon-sm"
          aria-label="Send message"
          disabled={disabled || text.trim().length === 0}
          onClick={() => void send()}
          className="shrink-0 rounded-lg"
        >
          {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </div>
  );
});
