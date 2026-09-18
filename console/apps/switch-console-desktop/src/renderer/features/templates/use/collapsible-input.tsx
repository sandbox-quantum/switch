import type { ReactNode } from 'react';

/**
 * An input the page already filled in shows as one line, its label and its
 * value, with a Change button. The deployer who accepts the value never
 * sees the control; the one who wants another opens it.
 */
export function CollapsibleInput({
  label,
  summary,
  collapsed,
  onOpen,
  disabled,
  children,
}: {
  label: string;
  summary: string;
  collapsed: boolean;
  onOpen: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border px-3 py-2.5">
      <span className="w-[104px] shrink-0 truncate text-[12.5px] font-medium">{label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground-muted"
        title={summary}
      >
        {summary}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={`Change ${label}`}
        className="shrink-0 cursor-pointer text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground disabled:cursor-default disabled:opacity-50"
      >
        Change
      </button>
    </div>
  );
}
