import { ChatMarkdown } from '@renderer/features/chats/ui/chat-markdown';
import { BuddyAvatar } from './buddy-avatar';
import { buddyWelcomeMessage } from './buddy-welcome-message';

/**
 * switch-buddy's welcome while it does not exist yet: the very message it
 * posts once created, drawn the way the chat draws an agent's message, so
 * nothing changes but the box below when the real one arrives.
 */
export function BuddyWelcome({
  firstName,
  agentName,
}: {
  firstName: string | null;
  agentName: string;
}) {
  return (
    <div className="flex gap-3" data-testid="buddy-welcome">
      <BuddyAvatar size={28} shape="round" className="mt-0.5" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <ChatMarkdown>{buddyWelcomeMessage({ firstName, agentName })}</ChatMarkdown>
      </div>
    </div>
  );
}
