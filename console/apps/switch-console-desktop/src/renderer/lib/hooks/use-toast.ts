import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
  action?: ToastAction;
  icon?: ReactNode;
  /**
   * Identifies the condition rather than the occurrence. Two toasts sharing an
   * id replace each other, so a failure that recurs on a timer says its piece
   * once instead of stacking up a wall of the same sentence.
   */
  id?: string;
};

function toast({ title, description, variant, action, icon, id }: Toast) {
  const options = {
    description,
    icon,
    ...(id && { id }),
    ...(action && { action: { label: action.label, onClick: action.onClick } }),
  };

  if (variant === 'destructive') {
    return sonnerToast.error(title, options);
  }
  return sonnerToast(title ?? '', options);
}

/**
 * Show a single toast that tracks a promise: a loading state while it runs, then
 * a success or error state when it settles. Use for actions with a noticeable
 * delay (e.g. a remote reset) so the user gets "working…" then "done" feedback
 * from one toast rather than a click with no acknowledgement.
 */
function toastPromise<T>(
  promise: Promise<T>,
  messages: { loading: string; success: string; error: (error: unknown) => string }
) {
  return sonnerToast.promise(promise, {
    loading: messages.loading,
    success: messages.success,
    error: (error: unknown) => messages.error(error),
  });
}

function useToast() {
  return { toast, toastPromise };
}

export { toast, toastPromise, useToast };
