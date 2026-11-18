import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';

/** Which of a chat's first messages slide in as it opens. */
export type ChatEntrance = {
  /** The agent's first message, whenever it appears. */
  firstAgent: boolean;
  /** Your own first message, as you sent it from elsewhere (Home). */
  firstOwn: boolean;
};

export const NO_ENTRANCE: ChatEntrance = { firstAgent: false, firstOwn: false };

/**
 * Chats opened from somewhere else (the end of onboarding, Home) that should
 * bring in their first messages rather than draw them at once. Asked for
 * before the chat opens, taken by the chat that opens.
 */
const introduced = new Map<string, ChatEntrance>();

/**
 * The chat `roomId` opens next with the agent's first message sliding in, and
 * with `own` your first message too.
 */
export function introduceChat(roomId: string, opening: 'agent' | 'own-and-agent'): void {
  introduced.set(roomId, { firstAgent: true, firstOwn: opening === 'own-and-agent' });
}

/**
 * What this chat was asked to bring in: read once as the chat opens, so
 * reopening it later draws everything at once. Nothing with reduced motion.
 */
export function useChatEntrance(roomId: string): ChatEntrance {
  const reduced = useReducedMotion() ?? false;
  const [asked] = useState(() => {
    const entrance = introduced.get(roomId) ?? NO_ENTRANCE;
    introduced.delete(roomId);
    return entrance;
  });
  return reduced ? NO_ENTRANCE : asked;
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
