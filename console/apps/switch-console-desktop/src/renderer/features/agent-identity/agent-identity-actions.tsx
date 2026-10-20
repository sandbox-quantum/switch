import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

/**
 * Rename and Delete, beside the agent's name, as two icons with a tooltip
 * each, so they take little room from the title. Delete is muted until
 * hovered, so it is found when looked for rather than shouting.
 */
export function AgentIdentityActions({
  onRename,
  onDelete,
  disabled,
}: {
  onRename: (() => void) | null;
  onDelete: (() => void) | null;
  disabled: boolean;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5 self-start pt-1">
      {onRename && (
        <IconAction label="Rename agent" onClick={onRename} disabled={disabled}>
          <Pencil />
        </IconAction>
      )}
      {onDelete && (
        <IconAction
          label="Delete agent"
          onClick={onDelete}
          disabled={disabled}
          className="hover:bg-background-destructive hover:text-foreground-destructive"
        >
          <Trash2 />
        </IconAction>
      )}
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={className}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
