/**
 * The PM's exact strings for people (the hosted UX stories, "Exact strings"),
 * as Console shows them. Switch web keeps the same words in its own module
 * (`peopleWords.ts`); the two apps can't share code, so `people-words.test.ts`
 * pins these to the table. Change the stories first, then both apps.
 */
export const PEOPLE_WORDS = {
  restingExplanation:
    'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.',
  emptyNoAgents: 'Add your first agent on Switch cloud',
  agentResting: 'Wakes when you message it',
  agentLoginNeeded: 'Check your AI login',
  checklist: {
    cloudReady: 'Your cloud is ready',
    cloudStopped: 'Your cloud is stopped',
    start: 'Start',
    loginSet: 'AI login set',
    loginMissing: 'No AI login yet',
    giveLogin: 'Give login',
    agentAdded: 'First agent added',
    agentMissing: 'No agent yet',
    addAgent: 'Add agent',
  },
} as const;
