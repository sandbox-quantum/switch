import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';

/**
 * Chats opened from somewhere else (the end of onboarding, Home) that should
 * bring in the agent's first message rather than draw it at once. Asked for
 * before the chat opens, taken by the chat that opens.
 */
const introduced = new Set<string>();

/** The chat `roomId` opens next with its agent's first message sliding in. */
export function introduceFirstAgentMessage(roomId: string): void {
  introduced.add(roomId);
}

/**
 * Whether this chat was asked to bring in its agent's first message: read once
 * as the chat opens, so reopening it later draws it at once. False with
 * reduced motion.
 */
export function useChatEntrance(roomId: string): boolean {
  const reduced = useReducedMotion() ?? false;
  const [asked] = useState(() => introduced.delete(roomId));
  return asked && !reduced;
}

/** Each item after the first in a group starts this much later than the one before. */
export const ENTRANCE_STAGGER = 0.15;

const HIDDEN = { opacity: 0, y: 12 } as const;
const SHOWN = { opacity: 1, y: 0 } as const;
const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Fades its children in as it slides them up from just below, when `play`;
 * otherwise draws them as they are. `order` staggers the items of a group.
 */
export function Entrance({
  play,
  order,
  children,
}: {
  play: boolean;
  order: number;
  children: ReactNode;
}) {
  if (!play) return <>{children}</>;
  return (
    <motion.div
      initial={HIDDEN}
      animate={SHOWN}
      transition={{ duration: 0.3, ease: EASE, delay: order * ENTRANCE_STAGGER }}
    >
      {children}
    </motion.div>
  );
}
