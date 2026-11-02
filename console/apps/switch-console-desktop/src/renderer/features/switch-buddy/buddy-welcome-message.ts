import { platformLogoMarkdown } from '@renderer/features/chats/ui/platform-logo';

/** The messaging apps the welcome offers, each with its logo, in the order buddy's AGENT.md numbers them. */
const PLATFORMS: { type: string; name: string }[] = [
  { type: 'slack', name: 'Slack' },
  { type: 'teams', name: 'Microsoft Teams' },
  { type: 'discord', name: 'Discord' },
  { type: 'telegram', name: 'Telegram' },
];

/**
 * The first message switch-buddy posts in its Welcome chat: who it is, and
 * where the person's team chats, as a numbered choice the buddy's
 * instructions pick up from. Written here, posted as the buddy, so it is
 * there the moment the chat opens rather than after the buddy's first
 * session starts. It does not know which apps are connected; the buddy
 * checks that itself once the person answers.
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
    `Hi${firstName ? ` ${firstName}` : ''}, I’m **${agentName}**, your assistant for everything Switch. 👋`,
    'I’ll set up agents with you and bring them to where your team already works.',
    '',
    '**Where does your team chat?**',
    ...PLATFORMS.map(
      ({ type, name }, index) => `${index + 1}. ${platformLogoMarkdown(type, name)}`
    ),
    `${PLATFORMS.length + 1}. We don’t use one, stay in Switch Console`,
    '',
    'Reply with a number or the app’s name.',
  ].join('\n');
}
