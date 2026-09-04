import { SendHorizontal } from 'lucide-react';
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
    <div className="flex items-end gap-2 border-t border-border bg-background px-3 py-2.5">
      <Textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="Message the agent"
        placeholder={composerPlaceholder(store.state, store.isRunning)}
        className="min-h-9 flex-1 py-1.5"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
      />
      <Button
        size="icon-sm"
        aria-label="Send message"
        disabled={disabled || text.trim().length === 0}
        onClick={() => void send()}
      >
        <SendHorizontal />
      </Button>
    </div>
  );
});
