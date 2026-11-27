import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { HOME_CHIP_TEXT, type HomeChipId } from '../model/home-chips';
import { Button } from '../primitives/button';
import { HomeBuddy } from './home-buddy';

const CONNECT_AI_BACKGROUND =
  'radial-gradient(ellipse 668.5px 123.5px at 8.5% 74%, rgba(161, 201, 210, 0.2) 0%, rgba(255, 137, 94, 0.2) 100%)';

function HomeHeading() {
  return (
    <h1 className="text-center text-3xl font-medium text-foreground">Let&rsquo;s work together</h1>
  );
}

/**
 * Home with switch-buddy ready: its box and the suggestions under it.
 * `onAsk` takes the message, and the suggestion it came from if any; it says
 * itself why it failed, and raising keeps the message in the box to send again.
 */
export function AskBuddyPanel({
  onAsk,
  chips,
}: {
  onAsk: (message: string, chip: HomeChipId | null) => Promise<void>;
  chips: HomeChipId[];
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const ask = async (text: string, chip: HomeChipId | null): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onAsk(body, chip);
      setDraft('');
    } catch {
      // onAsk has already said why; the draft stays for another try.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex w-full max-w-[720px] flex-col items-center gap-6">
      <HomeHeading />
      <div className="relative w-full">
        {/* Peeks out from behind the box, tilted. */}
        <HomeBuddy className="absolute -top-[57px] -left-[54px] -rotate-[8deg]" />
        <form
          className="relative flex w-full items-end gap-2 rounded-2xl border border-border bg-background px-5 py-3 shadow-[0_1px_1px_rgb(0_0_0/0.04),0_2px_4px_rgb(0_0_0/0.04),0_4px_10px_-2px_rgb(0_0_0/0.06)] focus-within:border-foreground-muted"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(draft, null);
          }}
        >
          {/* Grows with what is typed, up to ten lines, then scrolls. */}
          <textarea
            aria-label="Ask switch-buddy anything"
            placeholder="Ask switch-buddy anything"
            rows={1}
            value={draft}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends and Shift+Enter starts a new line; an IME
              // composing a character keeps its own Enter.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void ask(draft, null);
            }}
            className="[field-sizing:content] max-h-[calc(10lh+0.5rem)] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm leading-5 text-foreground outline-none placeholder:text-foreground-muted"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-sm"
            aria-label="Send"
            disabled={sending || !draft.trim()}
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {chips.map((chip) => (
          <Button
            key={chip}
            variant="outline"
            disabled={sending}
            onClick={() => void ask(HOME_CHIP_TEXT[chip], chip)}
          >
            {HOME_CHIP_TEXT[chip]}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Home before switch-buddy can chat: the way to connect the AI provider it
 * runs on. With `onConnect` null the button is off, and `unavailableReason`
 * says why when there is one.
 */
export function ConnectAiPanel({
  onConnect,
  unavailableReason,
}: {
  onConnect: (() => void) | null;
  unavailableReason: string | null;
}) {
  return (
    <div className="flex w-full max-w-[560px] flex-col items-center gap-8">
      <HomeHeading />
      <div
        className="flex w-full items-center justify-between gap-4 rounded-2xl px-5 py-4"
        style={{ background: CONNECT_AI_BACKGROUND }}
      >
        <p className="text-sm text-foreground">Connect to an AI provider to get started</p>
        {/* The title sits on a wrapper: a disabled button shows no tooltip. */}
        <span className="shrink-0" title={unavailableReason ?? undefined}>
          <Button
            variant="outline"
            className="bg-background"
            disabled={onConnect === null}
            onClick={() => onConnect?.()}
          >
            Connect to AI
          </Button>
        </span>
      </div>
    </div>
  );
}
