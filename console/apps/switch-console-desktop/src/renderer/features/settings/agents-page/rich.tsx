import type { RichText } from '@switch-console/shared';
import { cn } from '@renderer/utils/utils';

/** Rich text as React: each span one styled element. */
export function Rich({ text }: { text: RichText }) {
  return text.map((span, i) => {
    const className = cn(span.bold && 'font-semibold', span.italic && 'italic');
    if (span.code) {
      return (
        <code key={i} className={cn('rounded bg-background-tertiary px-1 break-all', className)}>
          {span.text}
        </code>
      );
    }
    return (
      <span key={i} className={className || undefined}>
        {span.text}
      </span>
    );
  });
}
