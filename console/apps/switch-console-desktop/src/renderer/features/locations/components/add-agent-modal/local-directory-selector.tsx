import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';

interface LocalDirectorySelectorProps {
  title: string;
  message: string;
  path?: string;
  onPathChange: (path: string) => void;
  placeholder?: string;
}

export function LocalDirectorySelector({
  title,
  message,
  onPathChange,
  path: initialPath,
  placeholder = 'Select a directory',
}: LocalDirectorySelectorProps) {
  const [path, setPath] = useState<string>(initialPath || '');

  const handleOpenFileDialog = async () => {
    const result = await rpc.app.openSelectDirectoryDialog({
      title,
      message,
    });
    if (result) {
      setPath(result);
      onPathChange(result);
    }
  };

  return (
    // A field with a button in it rather than one large button: the path is the
    // value being read, and making the whole row pressable made it look like the
    // value itself was the control.
    <div className="flex h-9 w-full items-center gap-2 rounded-md border border-border pr-1 pl-3">
      <p
        className={cn(
          'w-full min-w-0 flex-1 truncate text-left text-sm text-foreground-passive',
          path ? 'text-foreground' : ''
        )}
        // The tail of a path is the part that identifies it, so a long one is
        // clipped at the front; the whole thing stays available on hover.
        title={path || undefined}
        dir="rtl"
      >
        {path || placeholder}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="cursor-pointer text-foreground"
        onClick={handleOpenFileDialog}
      >
        Choose…
      </Button>
    </div>
  );
}
