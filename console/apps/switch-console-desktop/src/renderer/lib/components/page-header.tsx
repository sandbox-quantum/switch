import { Separator } from '../ui/separator';
import { type GlossaryTerm, TermInfo } from './term-info';

export function PageHeader({
  title,
  term,
  description,
  children,
  back,
  sticky = false,
}: {
  title: string;
  /** The Switch term the page is about, explained beside its title. */
  term?: GlossaryTerm;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * Navigation out of this page, rendered above the title at the top left.
   *
   * Kept out of `children`: those are the page's *actions*, and a way back is
   * not one — sitting it among them put "All hosts" in the middle of a row of
   * buttons that act on the host you are looking at.
   */
  back?: React.ReactNode;
  sticky?: boolean;
}) {
  const body = (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        {back && <div className="mb-1 flex">{back}</div>}
        <h2 className="flex items-center gap-2 text-xl">
          {title}
          {term && (
            <span className="flex">
              <TermInfo term={term} />
            </span>
          )}
        </h2>
        <p className="text-sm text-foreground-muted">{description}</p>
      </div>
      <div className="flex flex-col gap-4">
        {children}
        <Separator />
      </div>
    </div>
  );

  if (!sticky) return body;

  // Not a window drag region: Chromium places drag regions from layout and
  // does not clip them to the scrolling page, so after a scroll a stale one
  // could cover the titlebar and this header's own buttons. The window drags
  // from the top bar above every page.
  return <div className="sticky top-0 z-10 bg-background pt-10">{body}</div>;
}
