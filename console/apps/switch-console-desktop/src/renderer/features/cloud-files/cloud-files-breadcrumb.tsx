import { ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@renderer/utils/utils';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';
import { entryTitle, pathCrumbs } from './cloud-files-format';
import { useExplorerTransitions } from './explorer-motion';

/** Where you are: All files, then each folder (each opens it), then the open file's name if a file is open. */
export function Breadcrumb({
  path,
  rootEntries,
  onOpen,
  fileName,
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpen: (path: string) => void;
  fileName?: string;
}) {
  const crumbs = pathCrumbs(path);
  const motionSet = useExplorerTransitions();
  const top = rootEntries.find((entry) => entry.name === crumbs[0]?.name);
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 text-sm">
      <button
        type="button"
        className="shrink-0 text-foreground-muted hover:text-foreground"
        onClick={() => onOpen('')}
      >
        All files
      </button>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3 shrink-0 text-foreground-muted" aria-hidden />
          {/* The newest part (the folder just opened) fades in; still under reduced motion. */}
          <motion.button
            key={crumb.path}
            type="button"
            initial={index === crumbs.length - 1 ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={motionSet.enter}
            className={cn(
              'truncate',
              index === crumbs.length - 1 && fileName === undefined
                ? 'text-foreground'
                : 'text-foreground-muted hover:text-foreground'
            )}
            onClick={() => onOpen(crumb.path)}
          >
            {index === 0 && top ? entryTitle(top) : crumb.name}
          </motion.button>
        </span>
      ))}
      {fileName !== undefined && (
        <span className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3 shrink-0 text-foreground-muted" aria-hidden />
          <span className="truncate font-medium text-foreground" aria-current="page">
            {fileName}
          </span>
        </span>
      )}
    </nav>
  );
}
