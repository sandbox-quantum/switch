/**
 * The first message switch-buddy posts in its Welcome chat: who it is, what it
 * can do, and two tips. Written here, posted as the buddy, so it is there the
 * moment the chat opens rather than after the buddy's first session starts.
 *
 * The tips give the buddy's name in words, not as an @mention: posted by the
 * buddy, a mention of itself would be read as addressing it.
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
    'Switch brings your team to work with your agents, and I’m the first one.',
    '',
    'I can help you:',
    '- 🤖 Create agents',
    '- 🏠 Make rooms',
    '- 💬 Answer anything about Switch',
    '- 🧑‍💻 Any task, from researching a topic to writing a document',
    '',
    'Some tips:',
    '',
    '**👫 If you want your team to talk to me**',
    '- In my Settings tab, set “Who can talk to this agent” to “Anyone”.',
    '- Then invite your team members to the channel I’m in.',
    '',
    '**➕ If you want to add me to another channel**',
    '- Go to the channel where you want me.',
    `- Type \`/invite-agent\` followed by my name, ${agentName}.`,
  ].join('\n');
}
