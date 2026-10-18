import buddyAvatar from '@/assets/images/switch-buddy/avatar.png';
import { cn } from '@renderer/utils/utils';

/**
 * switch-buddy's face, the same picture the agent itself carries: bare, as
 * every agent's avatar is in lists and chats, or on a soft tile where it is
 * introduced.
 */
export function BuddyAvatar({
  size,
  shape,
  className,
}: {
  size: number;
  shape: 'round' | 'tile';
  className?: string;
}) {
  const image = (
    <img
      src={buddyAvatar}
      alt=""
      width={shape === 'tile' ? size * 0.8 : size}
      height={shape === 'tile' ? size * 0.8 : size}
      className={cn('shrink-0 object-contain', shape === 'round' && className)}
    />
  );
  if (shape === 'round') return image;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[22%] bg-background-tertiary',
        className
      )}
      style={{ width: size, height: size }}
    >
      {image}
    </span>
  );
}
