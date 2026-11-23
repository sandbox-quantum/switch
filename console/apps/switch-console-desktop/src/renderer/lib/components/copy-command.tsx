import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * A command for someone to paste into a chat app, with a button that copies
 * it. A failed copy says so: the command stays selectable to copy by hand.
 */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
    }
  };
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <code className="min-w-0 truncate rounded bg-background px-2 py-1 font-mono text-sm select-all">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={state === 'copied' ? `Copied ${command}` : `Copy ${command}`}
        className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
      >
        {state === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {state === 'failed' && (
        <span className="text-xs text-foreground-destructive">
          Couldn’t copy. Select it instead.
        </span>
      )}
    </span>
  );
}
