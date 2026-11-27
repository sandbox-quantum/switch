import { agentInitials } from '../model/agent-avatar';
import { cn } from '../model/cn';
import { personColour } from '../model/person-colour';

/**
 * A person's initials disc, in their colour (see `personColour`): people have
 * no picture in Switch. `userId` is their Switch user when known.
 */
export function PersonMark({
  name,
  userId,
  size,
}: {
  name: string;
  userId: string | null;
  size: 'sm' | 'md';
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-medium',
        size === 'md' ? 'size-7 text-xs' : 'size-[22px] text-[10px]'
      )}
      style={personColour(userId ?? name)}
    >
      {agentInitials(name)}
    </span>
  );
}
