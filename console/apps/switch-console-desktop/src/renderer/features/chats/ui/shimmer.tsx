import type { ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * Text with a light sweeping across it, for a label that names work still in
 * progress. CSS only — the `text-shimmer` class in `index.css` carries the
 * gradient, the animation and the reduced-motion opt-out.
 */
export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-shimmer inline-block', className)}>{children}</span>;
}
