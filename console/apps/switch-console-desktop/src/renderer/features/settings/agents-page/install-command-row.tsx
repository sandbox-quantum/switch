import { Check, Copy } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { buttonVariants } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { InstallMethod } from '@shared/core/providers/agent-payload';

// ---------------------------------------------------------------------------
// humanizeMethod
// ---------------------------------------------------------------------------

export function humanizeMethod(method: InstallMethod): string {
  const labels: Record<InstallMethod, string> = {
    'installer-macos': 'macOS Installer',
    'installer-windows': 'Windows Installer',
    'installer-linux': 'Linux Installer',
    homebrew: 'Homebrew',
    winget: 'winget',
    powershell: 'PowerShell',
    npm: 'npm',
    apt: 'apt',
    curl: 'curl',
    pip: 'pip',
    cargo: 'cargo',
    other: 'Other',
  };
  return labels[method] ?? method;
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

export function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="focus-visible:outline-ring shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground focus-visible:outline-2"
      aria-label="Copy command"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-foreground-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommandRow
// ---------------------------------------------------------------------------

export function CommandRow({ command, action }: { command: string; action: React.ReactNode }) {
  return (
    <div className="flex w-full items-stretch gap-[2px]">
      <div
        className={`group flex min-w-0 flex-1 items-center gap-2 bg-background-quaternary-1 px-2 py-1.5 ${action ? 'rounded-l-lg' : 'rounded-lg'}`}
      >
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground-muted">
          {command}
        </code>
        <CopyButton command={command} />
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommandActionButton
// ---------------------------------------------------------------------------

/**
 * The button joined to a {@link CommandRow}'s right edge: a design-system
 * button (primary unless `variant` says otherwise) in the row's shape.
 */
export function CommandActionButton({
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline';
}) {
  return (
    <button
      type="button"
      className={cn(
        buttonVariants({ variant }),
        'h-auto rounded-none rounded-r-lg px-4 disabled:cursor-not-allowed',
        className
      )}
      {...props}
    />
  );
}
