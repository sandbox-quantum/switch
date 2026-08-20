import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { AnimatedHeight } from './animated-height';

/**
 * The height the body may not exceed is the popup's own cap less whatever the
 * header and footer take, and only the header and footer know that. A constant
 * standing in for them is wrong in both directions: too generous and the body
 * pushes the footer past the popup's cap, which is how the New agent modal came
 * to paint its warning callout underneath the footer (CHOO-2243); too mean and
 * the modal is shorter than the window allows for no reason.
 *
 * So measure them and publish the total, rather than guess. Consumers cap their
 * scroll area with `max-h-[calc(100dvh-2rem-var(--modal-chrome))]` — `2rem`
 * being the popup's own margin, see `modal-renderer.tsx`. Until the first
 * measurement lands the variable is unset, so a consumer's fallback applies.
 */
export function ModalLayout({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [chrome, setChrome] = useState<number | null>(null);

  // Before paint: the body's cap depends on this, so a frame spent at the
  // fallback would be a frame at the wrong height.
  useLayoutEffect(() => {
    const elements = [headerRef.current, footerRef.current].filter(
      (el): el is HTMLDivElement => el !== null
    );
    if (elements.length === 0) return;

    // `offsetHeight`, not a bounding rect: the popup zooms as it opens, and a
    // rect measured mid-animation is scaled down with it — enough to under-
    // reserve and clip the footer against the popup's own cap.
    const measure = () => setChrome(elements.reduce((total, el) => total + el.offsetHeight, 0));

    measure();
    // The footer grows a row when it wraps, and again while it waits on a
    // remote host, so this is not a one-off measurement.
    const observer = new ResizeObserver(measure);
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={headerRef} className="shrink-0">
        {header}
      </div>
      <AnimatedHeight style={chrome === null ? undefined : { '--modal-chrome': `${chrome}px` }}>
        {children}
      </AnimatedHeight>
      <div ref={footerRef} className="shrink-0">
        {footer}
      </div>
    </>
  );
}
