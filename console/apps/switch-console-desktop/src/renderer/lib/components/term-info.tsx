import { InfoTooltip } from '@renderer/lib/components/info-tooltip';

/**
 * What Switch's own words mean, for someone meeting them for the first time.
 * One entry per term, so every "i" beside the same word says the same thing.
 */
export const GLOSSARY = {
  room: {
    name: 'Room',
    meaning:
      'A shared space where your team and AI agents work together, in your chat app or right here in Console.',
  },
  agent: {
    name: 'Agent',
    meaning:
      'An AI assistant that answers questions, takes actions and works with your tools. Each one runs on an AI provider.',
  },
  template: {
    name: 'Template',
    meaning:
      'A ready-made setup for an agent, a room or a group of rooms, with its roles and documents, that you create in one step.',
  },
  connector: {
    name: 'Connector',
    meaning:
      'A link from an agent to a service like GitHub, Notion or Jira, so it can read and act on your data there.',
  },
  messagingApp: {
    name: 'Messaging app',
    meaning:
      'The chat app your team already uses: Slack, Microsoft Teams, Discord or Telegram. Connecting one brings your agents and rooms into it.',
  },
  provider: {
    name: 'AI provider',
    meaning: 'The AI coding agent an agent runs on, like Claude Code or OpenAI Codex.',
  },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** An "i" beside a Switch term that says what it means. */
export function TermInfo({ term }: { term: GlossaryTerm }) {
  const { name, meaning } = GLOSSARY[term];
  return <InfoTooltip label={`What “${name}” means`} content={meaning} />;
}
