import { motion } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@renderer/utils/utils';

export function AnimatedHeight({
  children,
  className,
  onAnimatingChange,
}: {
  children: React.ReactNode;
  className?: string;
  onAnimatingChange?: (isAnimating: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Track the last observed height in a ref so the ResizeObserver callback
  // can detect actual changes without putting a side effect (setIsAnimating)
  // inside setHeight's updater function — pure-updater violations are
  // fragile in React StrictMode where updaters run twice.
  const lastHeightRef = useRef<number | undefined>(undefined);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [isAnimating, setIsAnimating] = useState(false);

  // Measure the initial height synchronously before the first paint so
  // framer-motion starts with an explicit pixel value rather than 'auto'.
  // This prevents the auto→pixel animation that would otherwise run on mount.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const initial = el.offsetHeight;
    lastHeightRef.current = initial;
    setHeight(initial);
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // The observer's first delivery is not redundant with the measurement
    // above: content that grows in between — a section that opens itself once
    // a query settles — is reported there and nowhere else. Discarding it
    // leaves the wrapper pinned too short, and its content then paints outside
    // the box, under whatever follows. `lastHeightRef` is what keeps an
    // unchanged first observation from animating.
    const ro = new ResizeObserver(() => {
      const next = el.offsetHeight;
      if (lastHeightRef.current === next) return;
      lastHeightRef.current = next;
      setHeight(next);
      setIsAnimating(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onAnimatingChange?.(isAnimating);
  }, [isAnimating, onAnimatingChange]);

  return (
    <motion.div
      animate={{ height: height ?? 'auto' }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className={cn('w-full', isAnimating ? 'overflow-hidden' : 'overflow-visible', className)}
      onAnimationComplete={() => setIsAnimating(false)}
    >
      <div ref={contentRef}>{children}</div>
    </motion.div>
  );
}
