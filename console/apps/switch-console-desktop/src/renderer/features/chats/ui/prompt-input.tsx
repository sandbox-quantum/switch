import { ArrowUpIcon, FileIcon, SquareIcon, XIcon } from 'lucide-react';
import {
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  type AttachmentState,
} from './attachment';

/**
 * The composer: a bordered box with the text on top and a footer row beneath it
 * (tools on the left, Send/Stop on the right). The text is controlled by the
 * caller; submitting — the Send button or Enter in the textarea — calls
 * `onSubmit` and leaves what to do with the text to it.
 */
export function PromptInput({
  onSubmit,
  children,
  className,
}: {
  onSubmit: () => void;
  children: ReactNode;
  className?: string;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      data-slot="prompt-input"
      className={cn(
        'flex w-full min-w-0 flex-col rounded-lg border border-border bg-background-1 transition-colors focus-within:border-border-primary',
        className
      )}
      onSubmit={handleSubmit}
    >
      {children}
    </form>
  );
}

/**
 * Enter submits the form, Shift+Enter inserts a newline, and Enter that commits
 * an IME composition does neither. A disabled submit button blocks Enter too, so
 * the keyboard cannot send what the button would refuse.
 */
export function PromptInputTextarea({
  className,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: ComponentProps<'textarea'>) {
  const [composing, setComposing] = useState(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (composing || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit?.disabled) return;
    form?.requestSubmit();
  };

  return (
    <textarea
      data-slot="prompt-input-textarea"
      rows={1}
      className={cn(
        'field-sizing-content max-h-60 min-h-14 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm text-foreground outline-none placeholder:text-foreground-passive disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      onKeyDown={handleKeyDown}
      onCompositionStart={(event) => {
        setComposing(true);
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        setComposing(false);
        onCompositionEnd?.(event);
      }}
      {...props}
    />
  );
}

export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-footer"
      className={cn('flex items-center justify-between gap-1 px-2 pb-2', className)}
      {...props}
    />
  );
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-tools"
      className={cn('flex min-w-0 items-center gap-1', className)}
      {...props}
    />
  );
}

/** A ghost button for the tools row. `tooltip` doubles as its accessible name. */
export function PromptInputButton({
  tooltip,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: ComponentProps<typeof Button> & { tooltip?: string }) {
  const button = (
    <Button type="button" variant={variant} size={size} aria-label={tooltip} {...props} />
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export type PromptInputStatus = 'idle' | 'sending' | 'running';

/**
 * Send while idle, a spinner while a send is in flight, and Stop while the agent
 * is running. A Stop that cannot be honoured stays visible but disabled, with
 * the reason on hover — it is kept focusable so the tooltip can still be read.
 */
export function PromptInputSubmit({
  status,
  onStop,
  stopDisabledReason,
  disabled,
  className,
}: {
  status: PromptInputStatus;
  onStop?: () => void;
  stopDisabledReason?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  if (status === 'running') {
    const reason = stopDisabledReason ?? null;
    const stop = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn('gap-1.5', className)}
        disabled={reason !== null || disabled || !onStop}
        focusableWhenDisabled
        title={reason ?? undefined}
        onClick={onStop}
      >
        <SquareIcon className="size-3 fill-current" />
        Stop
      </Button>
    );
    if (reason === null) return stop;
    return (
      <Tooltip>
        <TooltipTrigger render={stop} />
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    );
  }

  const sending = status === 'sending';
  return (
    <Button
      type="submit"
      variant="default"
      size="icon-sm"
      className={cn('rounded-full', className)}
      disabled={sending || disabled}
      aria-label={sending ? 'Sending' : 'Send'}
      title={sending ? 'Sending' : 'Send'}
    >
      {sending ? <Spinner size="sm" className="size-3.5" /> : <ArrowUpIcon />}
    </Button>
  );
}

export type PromptInputAttachmentItem = {
  id: string;
  name: string;
  mediaType?: string;
  /** An image preview URL; files without one show a file icon. */
  previewUrl?: string;
  state?: AttachmentState;
};

/** The files queued with the message, each removable. Renders nothing when empty. */
export function PromptInputAttachments({
  items,
  onRemove,
  className,
}: {
  items: PromptInputAttachmentItem[];
  onRemove: (id: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <AttachmentGroup data-slot="prompt-input-attachments" className={cn('px-3 pt-3', className)}>
      {items.map((item) => (
        <Attachment key={item.id} size="xs" state={item.state ?? 'done'} className="min-w-0">
          <AttachmentMedia variant={item.previewUrl ? 'image' : 'icon'}>
            {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <FileIcon />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle className="max-w-48" title={item.name}>
              {item.name}
            </AttachmentTitle>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction
              aria-label={`Remove ${item.name}`}
              title={`Remove ${item.name}`}
              onClick={() => onRemove(item.id)}
            >
              <XIcon />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
