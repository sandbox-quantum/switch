import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Field, FieldLabel } from '../primitives/field';
import { Textarea } from '../primitives/textarea';

/**
 * The instructions box itself, whatever holds the text: a label, an Expand
 * control once the text outgrows the box, and room for actions beside it.
 */
export function AgentInstructionsField({
  value,
  onChange,
  expanded,
  onExpandedChange,
  actions,
}: {
  value: string;
  onChange: (value: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  actions: React.ReactNode;
}) {
  const fieldId = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [value, expanded]);

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={fieldId}>
          Agent instructions <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <span className="flex items-center gap-3">
          {actions}
          {(clipped || expanded) && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={fieldId}
              onClick={() => onExpandedChange(!expanded)}
              className="cursor-pointer text-sm text-foreground-muted hover:text-foreground"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </span>
      </div>
      <Textarea
        ref={boxRef}
        id={fieldId}
        rows={4}
        placeholder="How this agent should work"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={expanded ? 'max-h-none' : undefined}
      />
    </Field>
  );
}
