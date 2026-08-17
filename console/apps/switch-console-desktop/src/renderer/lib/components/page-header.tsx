import { Separator } from '../ui/separator';

export function PageHeader({
  title,
  description,
  children,
  back,
  sticky = false,
}: {
  title: string;
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
      <div className="flex flex-col gap-1 [-webkit-app-region:drag]">
        {back && <div className="mb-1 flex [-webkit-app-region:no-drag]">{back}</div>}
        <h2 className="text-xl">{title}</h2>
        <p className="text-sm text-foreground-muted">{description}</p>
      </div>
      <div className="flex flex-col gap-4 [-webkit-app-region:no-drag]">
        {children}
        <Separator />
      </div>
    </div>
  );

  if (!sticky) return body;

  return (
    <div className="sticky top-0 z-10 bg-background pt-10 [-webkit-app-region:drag]">{body}</div>
  );
}
