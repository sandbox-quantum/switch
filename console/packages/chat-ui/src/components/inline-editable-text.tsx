import { useState } from 'react';
import { cn } from '../model/cn';

/**
 * Text that becomes a box when clicked, for the parts of a page header that are
 * edited where they are read. Every keystroke is reported, so an edit is a
 * pending change like any other on the page; Escape puts back what was there
 * when editing began. Apps that save on commit rather than every keystroke can
 * use `onCommit` (Enter/blur) while ignoring `onChange`.
 */
export function InlineEditableText({
  value,
  placeholder,
  mutedPlaceholder,
  label,
  className,
  onChange,
  onCommit,
}: {
  value: string;
  placeholder: string;
  mutedPlaceholder: boolean;
  label: string;
  className: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const [editingFrom, setEditingFrom] = useState<string | null>(null);

  const commit = () => {
    if (onCommit) {
      onCommit(value);
    }
    setEditingFrom(null);
  };

  if (editingFrom !== null)
    return (
      <input
        autoFocus
        aria-label={label}
        value={value}
        placeholder={placeholder}
        className={cn(
          'w-full min-w-0 rounded-sm bg-transparent outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className
        )}
        onChange={(event) => onChange(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            onChange(editingFrom);
            setEditingFrom(null);
          }
        }}
      />
    );

  return (
    <button
      type="button"
      aria-label={`Edit ${label.toLowerCase()}`}
      title="Click to edit"
      className={cn(
        '-mx-1 max-w-[calc(100%+0.5rem)] cursor-text rounded-sm px-1 text-left [overflow-wrap:anywhere] hover:bg-[var(--sel-soft)]',
        !value && mutedPlaceholder && 'text-foreground-muted',
        className
      )}
      onClick={() => setEditingFrom(value)}
    >
      {value || placeholder}
    </button>
  );
}
