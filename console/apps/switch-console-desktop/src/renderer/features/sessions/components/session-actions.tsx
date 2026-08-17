import { Archive, Copy, MessageSquare, Pencil, Pin, PinOff, RotateCcw, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';

/**
 * What can be done to a session, as one list.
 *
 * A session is acted on from two places that must offer the same things —
 * right-clicking it, and the row's own actions button — and they were only the
 * same for as long as someone kept them so. The list is built once here and
 * both menus render it, so an action added to a session cannot arrive in one
 * menu and be missing from the other.
 */

export interface SessionActionsProps {
  isPinned: boolean;
  canPin: boolean;
  isArchived: boolean;
  branchName?: string;
  onPin: () => void;
  onUnpin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRestore?: () => void;
  onReconnect?: () => void;
  onConvertAutomation?: () => void;
  onDelete: () => void;
}

export interface SessionAction {
  key: string;
  icon: ReactNode;
  label: string;
  run: () => void;
  destructive?: boolean;
  /** Set the item apart from the ones above it. */
  separatorBefore?: boolean;
}

async function copyBranchName(branchName: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(branchName);
    toast({ title: 'Branch name copied' });
  } catch {
    toast({
      title: 'Copy failed',
      description: 'The branch name could not be copied to the clipboard.',
      variant: 'destructive',
    });
  }
}

export function sessionActions({
  isPinned,
  canPin,
  isArchived,
  branchName,
  onPin,
  onUnpin,
  onRename,
  onArchive,
  onRestore,
  onReconnect,
  onConvertAutomation,
  onDelete,
}: SessionActionsProps): SessionAction[] {
  const actions: SessionAction[] = [];

  if (canPin) {
    actions.push(
      isPinned
        ? {
            key: 'unpin',
            icon: <PinOff className="size-4" />,
            label: 'Unpin session',
            run: onUnpin,
          }
        : { key: 'pin', icon: <Pin className="size-4" />, label: 'Pin session', run: onPin }
    );
  }
  actions.push({
    key: 'rename',
    icon: <Pencil className="size-4" />,
    label: 'Rename',
    run: onRename,
  });
  if (onReconnect) {
    actions.push({
      key: 'reconnect',
      icon: <RotateCcw className="size-4" />,
      label: 'Reconnect',
      run: onReconnect,
    });
  }
  if (onConvertAutomation) {
    actions.push({
      key: 'convert',
      icon: <MessageSquare className="size-4" />,
      label: 'Convert to regular session',
      run: onConvertAutomation,
    });
  }
  if (!isArchived) {
    actions.push({
      key: 'archive',
      icon: <Archive className="size-4" />,
      label: 'Archive',
      run: onArchive,
    });
  }
  if (isArchived && onRestore) {
    actions.push({
      key: 'restore',
      icon: <RotateCcw className="size-4" />,
      label: 'Restore',
      run: onRestore,
    });
  }
  if (branchName) {
    actions.push({
      key: 'copy-branch',
      icon: <Copy className="size-4" />,
      label: 'Copy branch name',
      run: () => void copyBranchName(branchName),
    });
  }
  actions.push({
    key: 'delete',
    icon: <Trash2 className="size-4" />,
    label: 'Delete',
    run: onDelete,
    destructive: true,
    separatorBefore: true,
  });

  return actions;
}
