import { ArrowDownIcon } from 'lucide-react';
import * as React from 'react';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import { FOLLOW_BOTTOM_THRESHOLD_PX, isAtBottom } from './follow-bottom';

type MessageScrollerContextValue = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  followingRef: React.RefObject<boolean>;
  atBottom: boolean;
  setAtBottom: (atBottom: boolean) => void;
  scrollToEnd: (behavior: ScrollBehavior) => void;
};

const MessageScrollerContext = React.createContext<MessageScrollerContextValue | null>(null);

function useMessageScrollerContext(): MessageScrollerContextValue {
  const context = React.useContext(MessageScrollerContext);
  if (!context) throw new Error('MessageScroller parts must be rendered inside <MessageScroller>');
  return context;
}

/**
 * Where the reader is in the transcript, and a way to jump to the end. Following
 * is on while the viewport sits at the bottom: new content then keeps it pinned
 * there. Scrolling up stops following; scrolling back down, or `scrollToEnd`,
 * resumes it.
 */
function useMessageScroller(): { isAtBottom: boolean; scrollToEnd: () => void } {
  const { atBottom, scrollToEnd } = useMessageScrollerContext();
  return { isAtBottom: atBottom, scrollToEnd: () => scrollToEnd('smooth') };
}

function MessageScroller({ className, ...props }: React.ComponentProps<'div'>) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const followingRef = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const scrollToEnd = React.useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followingRef.current = true;
    setAtBottom(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const value = React.useMemo(
    () => ({ viewportRef, followingRef, atBottom, setAtBottom, scrollToEnd }),
    [atBottom, scrollToEnd]
  );

  return (
    <MessageScrollerContext.Provider value={value}>
      <div
        data-slot="message-scroller"
        data-at-bottom={atBottom}
        className={cn(
          'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
          className
        )}
        {...props}
      />
    </MessageScrollerContext.Provider>
  );
}

function MessageScrollerViewport({ className, onScroll, ...props }: React.ComponentProps<'div'>) {
  const { viewportRef, followingRef, setAtBottom } = useMessageScrollerContext();

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const atEnd = isAtBottom(event.currentTarget, FOLLOW_BOTTOM_THRESHOLD_PX);
    followingRef.current = atEnd;
    setAtBottom(atEnd);
    onScroll?.(event);
  };

  return (
    <div
      data-slot="message-scroller-viewport"
      className={cn(
        'size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
        className
      )}
      {...props}
      ref={viewportRef}
      onScroll={handleScroll}
    />
  );
}

function MessageScrollerContent({ className, ...props }: React.ComponentProps<'div'>) {
  const { viewportRef, followingRef } = useMessageScrollerContext();
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const stick = () => {
      if (followingRef.current) viewport.scrollTop = viewport.scrollHeight;
    };
    stick();
    // Content growing (a streamed reply) and the viewport shrinking (the composer
    // growing beneath it) both move the end out of view.
    const observer = new ResizeObserver(stick);
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef, followingRef]);

  return (
    <div
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-8', className)}
      {...props}
      ref={contentRef}
    />
  );
}

function MessageScrollerItem({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-scroller-item"
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  );
}

function MessageScrollerButton({
  className,
  children,
  variant = 'outline',
  size = 'icon-sm',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  const { atBottom, scrollToEnd } = useMessageScrollerContext();
  const active = !atBottom;

  return (
    <Button
      data-slot="message-scroller-button"
      data-active={active}
      aria-hidden={!active}
      tabIndex={active ? 0 : -1}
      variant={variant}
      size={size}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-sm transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 motion-reduce:transition-none',
        className
      )}
      {...props}
      onClick={() => scrollToEnd('smooth')}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">Scroll to end</span>
        </>
      )}
    </Button>
  );
}

export {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
};
