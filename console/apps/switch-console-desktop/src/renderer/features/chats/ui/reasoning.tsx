import { ChevronRightIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { cn } from '@renderer/utils/utils';
import { ChatMarkdown } from './chat-markdown';
import { Shimmer } from './shimmer';

const ROW_CLASS = 'flex items-center gap-1 py-0.5 text-xs text-foreground-muted';

/**
 * The model's thinking, folded into one muted row ("Thought for 4s"). With no
 * text there is nothing to open, so the row is a plain label without a caret.
 */
export function Reasoning({
  label,
  shimmer = false,
  text,
  defaultOpen = false,
}: {
  label: string;
  shimmer?: boolean;
  text: string;
  defaultOpen?: boolean;
}) {
  const labelNode = shimmer ? <Shimmer>{label}</Shimmer> : <span>{label}</span>;

  if (text.length === 0) {
    return (
      <div data-slot="reasoning" className={ROW_CLASS}>
        {labelNode}
      </div>
    );
  }

  return (
    <Collapsible data-slot="reasoning" defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className={cn(
          'group/reasoning cursor-pointer outline-none hover:text-foreground focus-visible:text-foreground',
          ROW_CLASS
        )}
      >
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[panel-open]/reasoning:rotate-90 motion-reduce:transition-none" />
        {labelNode}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l border-border pl-3 text-xs text-foreground-muted">
        <ChatMarkdown className="text-xs text-foreground-muted">{text}</ChatMarkdown>
      </CollapsibleContent>
    </Collapsible>
  );
}
