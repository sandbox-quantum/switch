import { useEffect, useRef } from 'react';

/**
 * The managed stack's recent output, scrolled to the newest line.
 *
 * `placeholder` keeps the panel on screen before the first line arrives. Docker
 * is silent for a while at the start of a pull — it is resolving the registry,
 * not stalled — and an empty space there read as nothing happening at all. It
 * is styled apart from the output so it cannot be mistaken for a line docker
 * printed.
 */
export function LogTail({ lines, placeholder }: { lines: string[]; placeholder: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0 && !placeholder) return null;

  return (
    <div
      ref={ref}
      className="max-h-48 overflow-auto rounded-md border border-border bg-background-tertiary p-2 font-mono text-[11px] leading-relaxed text-foreground-muted"
    >
      {lines.length === 0 && placeholder && (
        <div className="text-foreground-tertiary-passive italic">{placeholder}</div>
      )}
      {lines.map((line, i) => (
        // Log lines have no stable id; index is fine for an append-only tail.
        <div key={i} className="break-all whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  );
}
