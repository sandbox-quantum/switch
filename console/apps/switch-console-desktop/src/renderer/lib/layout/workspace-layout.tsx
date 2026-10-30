import { detectPlatform } from '@tanstack/hotkeys';
import { type ReactNode } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { cn } from '@renderer/utils/utils';

const LEFT_PANEL_DEFAULT_SIZE = '274px';
const LEFT_SIDEBAR_MIN_SIZE = '200px';
const LEFT_SIDEBAR_MAX_SIZE = '30%';
const MAIN_PANEL_MIN_SIZE = '30%';

const isMac = detectPlatform() === 'mac';

interface WorkspaceLayoutProps {
  leftSidebar: ReactNode;
  mainContent: ReactNode;
  /** Content overlaid on the main panel, outside the per-view subtree that is
   * remounted on navigation. */
  persistentLayer?: ReactNode;
  /** Across the top of the main panel, above the view, when the workspace has
   * something to say about itself — such as its server not running. */
  banner: ReactNode;
  /** Classes for the view and the persistent layer under the banner. */
  contentClassName: string | undefined;
}

export function WorkspaceLayout({
  leftSidebar,
  mainContent,
  persistentLayer = null,
  banner,
  contentClassName,
}: WorkspaceLayoutProps) {
  const { leftPanelRef, syncLeftOpenFromPanel, isLeftOpen } = useWorkspaceLayoutContext();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'workspace-outer',
    storage: localStorage,
  });

  return (
    <ResizablePanelGroup
      id="workspace-outer"
      orientation="horizontal"
      className="h-full w-full overflow-hidden"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="workspace-left"
        panelRef={leftPanelRef}
        defaultSize={LEFT_PANEL_DEFAULT_SIZE}
        minSize={LEFT_SIDEBAR_MIN_SIZE}
        maxSize={LEFT_SIDEBAR_MAX_SIZE}
        collapsedSize="0%"
        onResize={syncLeftOpenFromPanel}
        collapsible
      >
        {leftSidebar}
      </ResizablePanel>
      <ResizableHandle
        // The gutter and the panel's radius already separate sidebar from
        // content, so the handle carries no line of its own — it only shows
        // one while the pointer is on it, to say the edge can be dragged.
        className={cn(
          'items-center justify-center bg-transparent transition-colors hover:bg-[var(--hair)]',
          isLeftOpen ? 'flex' : 'hidden'
        )}
      />
      <ResizablePanel id="workspace-main" minSize={MAIN_PANEL_MIN_SIZE}>
        {/* The panel is an inset card on the window's material rather than a
            pane butted against the sidebar: the gutter and the radius separate
            the two, in place of a divider. Flush to the sidebar on the left,
            8px away on the other three sides. The hairline is a spread shadow
            rather than a border so it lands on a half pixel and does not take
            a whole one out of the panel; the 1px left gutter keeps the clip from
            eating it on the flush side.

            With the sidebar collapsed there is no sidebar to be flush against,
            so the card insets on the left too — and on macOS it starts below
            the traffic lights instead of behind them. The sidebar's empty top
            strip was what kept them clear; without it the card was drawing its
            own corner under the close button. */}
        <div
          className={cn(
            'relative h-full w-full overflow-hidden pr-2 pb-2 [-webkit-app-region:drag]',
            isLeftOpen ? 'pt-2 pl-px' : 'pl-2',
            !isLeftOpen && (isMac ? 'pt-9' : 'pt-2')
          )}
        >
          <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[var(--panel-radius)] shadow-[0_0_0_0.5px_var(--hair)] [-webkit-app-region:no-drag]">
            {banner}
            <div className={cn('relative min-h-0 w-full flex-1', contentClassName)}>
              {mainContent}
              {persistentLayer}
            </div>
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

interface WorkspaceContentLayoutProps {
  titlebarSlot: ReactNode;
  mainPanel: ReactNode;
}

export function WorkspaceContentLayout({ titlebarSlot, mainPanel }: WorkspaceContentLayoutProps) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {titlebarSlot}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">{mainPanel}</div>
      </div>
    </div>
  );
}
