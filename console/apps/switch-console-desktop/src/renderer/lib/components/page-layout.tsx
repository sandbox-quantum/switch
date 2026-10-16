import { ExternalLink } from 'lucide-react';
import React from 'react';
import { cn } from '@renderer/utils/utils';

export type PageSidebarItem<T extends string = string> = {
  id: T;
  label: string;
  isExternal?: boolean;
};

export function PageSidebarMenu<T extends string>({
  items,
  activeId,
  onSelect,
}: {
  items: ReadonlyArray<PageSidebarItem<T>>;
  activeId: T;
  onSelect: (item: PageSidebarItem<T>) => void;
}) {
  return (
    <div className="sticky top-0 self-start py-10 [-webkit-app-region:drag]">
      <nav className="flex w-52 flex-col gap-0.5 [-webkit-app-region:no-drag]">
        {items.map((item) => (
          <PageSidebarButton
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onSelect}
          />
        ))}
      </nav>
    </div>
  );
}

export type PageSidebarGroup<T extends string = string> = {
  /** What the group's items act on, such as "Workspace". */
  label: string;
  /** Which one, such as the workspace's name. */
  detail: string;
  items: ReadonlyArray<PageSidebarItem<T>>;
};

/**
 * `PageSidebarMenu` with its items under headings, for a page whose sections
 * reach different things: the heading says what each group acts on, so the
 * sections under it need not.
 */
export function PageSidebarGroups<T extends string>({
  groups,
  activeId,
  onSelect,
}: {
  groups: ReadonlyArray<PageSidebarGroup<T>>;
  activeId: T;
  onSelect: (item: PageSidebarItem<T>) => void;
}) {
  return (
    <div className="sticky top-0 self-start py-10 [-webkit-app-region:drag]">
      <nav className="flex w-52 flex-col gap-5 [-webkit-app-region:no-drag]">
        {groups.map((group) => (
          <div
            key={group.label}
            role="group"
            aria-label={group.label}
            className="flex flex-col gap-0.5"
          >
            <p className="truncate px-3 pb-1 text-xs text-foreground-muted" title={group.detail}>
              <span className="font-medium tracking-wide uppercase">{group.label}</span> ·{' '}
              {group.detail}
            </p>
            {group.items.map((item) => (
              <PageSidebarButton
                key={item.id}
                item={item}
                active={item.id === activeId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

function PageSidebarButton<T extends string>({
  item,
  active,
  onSelect,
}: {
  item: PageSidebarItem<T>;
  active: boolean;
  onSelect: (item: PageSidebarItem<T>) => void;
}) {
  const isActive = active && !item.isExternal;
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(item)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-normal text-foreground-muted transition-colors hover:bg-background-1 hover:text-foreground',
        isActive && 'bg-background-2 text-foreground hover:bg-background-2 hover:text-foreground'
      )}
    >
      <span className="text-left">{item.label}</span>
      {item.isExternal && <ExternalLink className="h-4 w-4" />}
    </button>
  );
}

export function PageContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full max-w-4xl px-4', className)}>{children}</div>;
}

export function PageLayout({
  width,
  sidebar,
  children,
}: {
  /** The column's maximum width, in pixels. */
  width: number;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="h-full scrollbar-gutter-stable overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full px-8" style={{ maxWidth: width }}>
          <div className="grid w-full grid-cols-[13rem_minmax(0,1fr)] gap-8">
            {sidebar}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
