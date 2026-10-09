import { useState } from 'react';
import { ChatMarkdown } from './chat-markdown';
import { ThinkingIcon, WorkLogDetails, WorkLogRow } from './work-log';

/**
 * The model's thinking as one work-log line ("Thought for 4s"). With no text
 * there is nothing to open, so the line is a plain label.
 */
export function Reasoning({
  label,
  shimmer = false,
  text,
}: {
  label: string;
  shimmer?: boolean;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const openable = text.length > 0;
  return (
    <div data-slot="reasoning">
      <WorkLogRow
        icon={<ThinkingIcon />}
        label={label}
        active={shimmer}
        {...(openable ? { open, onToggle: () => setOpen(!open) } : {})}
      >
        {openable && open && (
          <WorkLogDetails>
            <div className="max-h-96 overflow-auto border-l border-border pl-3 select-text">
              <ChatMarkdown className="text-xs text-foreground-muted">{text}</ChatMarkdown>
            </div>
          </WorkLogDetails>
        )}
      </WorkLogRow>
    </div>
  );
}
