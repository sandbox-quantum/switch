import { platformLogoMarkdown } from '@switch-console/chat-ui/model/platform-logo';

/** The messaging apps the welcome names, each with its logo. */
const PLATFORMS: { type: string; name: string }[] = [
  { type: 'slack', name: 'Slack' },
  { type: 'teams', name: 'Microsoft Teams' },
  { type: 'discord', name: 'Discord' },
  { type: 'telegram', name: 'Telegram' },
];

function platformList(): string {
  const named = PLATFORMS.map(({ type, name }) => platformLogoMarkdown(type, name));
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * The first message switch-buddy posts in its Welcome chat: who it is, that
 * Switch brings agents to the messaging apps a team already uses, and what it
 * can help with. Written here, posted as the buddy, so it is there the moment
 * the chat opens rather than after the buddy's first session starts.
 *
 * The apps' logos are drawn by Console's chat; the Welcome chat is read there.
 */
export function buddyWelcomeMessage({
  firstName,
  agentName,
}: {
  firstName: string | null;
  agentName: string;
}): string {
  return [
    // The intro calls it switch-buddy; the name it goes by from here on carries the person too.
    `Hi${firstName ? ` ${firstName}` : ''}, I’m **${agentName}**, your ${agentName === 'switch-buddy' ? 'assistant' : 'switch-buddy'} for everything Switch. 👋`,
    '',
    `Switch brings your agents to where your team already works: ${platformList()}. Your team talks to agents in the channels they already use, and people and agents work together in shared rooms.`,
    '',
    'I can help you:',
    '- 🔌 Connect your team’s chat app',
    '- 🤖 Create agents and bring them into your channels',
    '- 🏠 Set up rooms where your team and agents work together',
    '- 💬 Answer anything about Switch',
    '',
    'Tell me which app your team uses, and I’ll walk you through connecting it.',
  ].join('\n');
}

/** What the buddy says first in the Slack or Discord channel it continues in, once setup is done. */
export function buddyChannelOpener(firstName: string | null, platform: string): string {
  return [
    `Hi${firstName ? ` ${firstName}` : ''}, setup is done: ${platform} is connected and this is our private channel. 🎉`,
    'From here I can help you create agents and bring them into your team’s channels.',
    'What do you mostly work on?',
  ].join('\n\n');
}
