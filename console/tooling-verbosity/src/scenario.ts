/**
 * What a scenario is: one room, as the agent finds it, and the message that
 * addresses it there.
 *
 * Everything the agent can learn about the room comes from here, through the
 * fake Switch server's answers to its tool calls (`fake-switch.ts`). The
 * repository the agent works in is pinned to `repoCommit`, so a run can dig
 * into the code the way a real agent would, and two runs see the same code.
 */

export type Participant = {
  name: string;
  type: 'user' | 'agent';
  /** The workspace role a user's messages arrive with. */
  role?: 'owner' | 'admin' | 'member';
};

export type HistoryMessage = {
  sender: string;
  body: string;
  /** Minutes before the addressed message. */
  minutesAgo: number;
};

export type Scenario = {
  name: string;
  /** What the scenario is modelled on, and what a good answer looks like. */
  about: string;
  /** The commit of this repository the agent works in. */
  repoCommit: string;
  /** The agent under test, as the room knows it. */
  agentName: string;
  /** The agent's own instructions, after the skill; empty for none. */
  agentInstructions: string;
  room: {
    name: string;
    description: string;
    /** The room-specific instructions `connect_to_room` returns; empty for none. */
    instructions: string;
    platform: string;
    participants: Participant[];
  };
  /** The room's timeline before the addressed message, oldest first. */
  history: HistoryMessage[];
  /** The message that addresses the agent. */
  message: { sender: string; body: string };
};
