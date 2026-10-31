/**
 * The scenarios, each modelled on a kind of exchange seen in real rooms.
 * Names and details are made up; the shape of the ask is what matters.
 */
import type { Participant, Scenario } from './scenario';

/** Main as of mid-October 2026, when the exchanges these model took place. */
const COMMIT = 'd9863fdb83a3ecdf9889a967c15214f43efad946';

const TEAM: Participant[] = [
  { name: 'dana.reyes', type: 'user', role: 'member' },
  { name: 'sam.okafor', type: 'user', role: 'admin' },
  { name: 'alex.moreau', type: 'user', role: 'member' },
];

const PLATFORM_ROOM = {
  name: 'switch-platform',
  description: 'Day-to-day discussion of the Switch platform: infrastructure, testing, releases.',
  instructions: '',
  platform: 'Slack',
  participants: TEAM,
};

const CHATTER = [
  {
    sender: 'sam.okafor',
    body: 'Release candidate is cut, dev is on it. Shout if anything looks off.',
    minutesAgo: 95,
  },
  { sender: 'alex.moreau', body: 'Looks fine from the console side 👍', minutesAgo: 80 },
];

export const SCENARIOS: Record<string, Scenario> = {
  /**
   * A broad design question in a team channel. What came back in the real
   * exchange was a long structured essay: headings, a list of constraints,
   * a closing offer. What the asker needed was a recommendation and the few
   * things that change it.
   */
  'design-question': {
    name: 'design-question',
    about:
      'Open-ended design question about end-to-end testing in deployed environments. ' +
      'A good reply leads with a recommendation and keeps to what changes the decision.',
    repoCommit: COMMIT,
    agentName: 'platform-agent',
    agentInstructions: '',
    room: PLATFORM_ROOM,
    history: CHATTER,
    message: {
      sender: 'dana.reyes',
      body:
        "I'd like to start a ticket for e2e testing in our deployed environments (dev and staging). " +
        'In dev I want Playwright tests running in CI, where you can pick which environment to run against. ' +
        "They're about checking that features exist and behave as expected, so coverage matters, and ideally " +
        "some way of noticing that a new feature isn't tested. In staging I'd like load testing and " +
        "scenario-based testing. Let's not go deep on load testing, just keep it as a next step. " +
        "For scenarios, I'd like to brainstorm predefined, templated scenarios of agent and user behaviour, " +
        'carried out by a smaller LLM agent inside staging, simulating normal use: creating rooms, sending ' +
        'messages, creating agents and so on. Simple at first, more complex later. A full-strength model ' +
        'would watch each run and judge whether Switch behaved correctly. The tricky part is probably making ' +
        'sure every feature is available in staging and that agents can use them. We can mock some external ' +
        'things, but it should be as realistic as possible, e.g. how would we emulate Slack in the scenarios? ' +
        "This is an exercise in finding the right approach, and once we have it we'll write the tickets. " +
        'What are our options for building such a harness, and what problems should we know about before we start?',
    },
  },

  /**
   * A narrow factual question. The answer is a sentence or two and a reason.
   */
  'quick-question': {
    name: 'quick-question',
    about:
      'Narrow yes/no question about the codebase. A good reply is a few sentences: the answer and why.',
    repoCommit: COMMIT,
    agentName: 'platform-agent',
    agentInstructions: '',
    room: PLATFORM_ROOM,
    history: CHATTER,
    message: {
      sender: 'alex.moreau',
      body: 'quick one: could we run switch-core with 2 replicas today, or would something break?',
    },
  },

  /**
   * An ask that takes real digging before there is anything to say. Checks
   * the other half of the writing rules: a one-line heads-up before going
   * quiet, then a findings report that stays a chat message.
   */
  investigation: {
    name: 'investigation',
    about:
      'A question that needs several minutes of code reading. A good run posts a one-line ' +
      'heads-up first, then a short finding: the answer, the gap if any, what to do.',
    repoCommit: COMMIT,
    agentName: 'platform-agent',
    agentInstructions: '',
    room: PLATFORM_ROOM,
    history: CHATTER,
    message: {
      sender: 'dana.reyes',
      body:
        'Someone told me agents sometimes answer in their final text instead of posting to the room, ' +
        'so the person never sees the reply. Can you dig into how we guard against that and whether ' +
        "there's still a gap?",
    },
  },

  /**
   * An explicit ask for step-by-step instructions, where length is earned.
   * The check here is the other way round: a fix for verbosity must not cut
   * steps the person needs.
   */
  'step-by-step': {
    name: 'step-by-step',
    about:
      'Explicit request for step-by-step setup instructions. A good reply is complete; ' +
      'length is justified, padding is not.',
    repoCommit: COMMIT,
    agentName: 'platform-agent',
    agentInstructions: '',
    room: PLATFORM_ROOM,
    history: CHATTER,
    message: {
      sender: 'sam.okafor',
      body:
        "I want to run the console e2e harness against a Switch I start locally. Give me the steps, I haven't done it before.",
    },
  },
};
