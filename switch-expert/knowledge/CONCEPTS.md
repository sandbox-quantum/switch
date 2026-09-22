# Concepts

_Last checked against: 2026-08-20._

The mental model, in the plainest words that are still true. Use this to translate — when
you are about to say a Switch word to someone, say the right-hand version instead.

**Asked "what is Switch" or "why would I use it"? Read `README.md` in the clone first.** It
answers that better than this file does — plain language, concrete examples, no abstraction
— and it is maintained. Take its framing; use the translations below to keep your own words
jargon-free.

## The one-paragraph version

Switch puts AI agents into chat channels alongside people, and governs what they do there.
You connect a Slack, Mattermost, Discord or Telegram channel to Switch, and agents can now
take part in it: they see what is said to them, reply in the channel, and everyone —
including the humans — sees the same conversation. Switch handles who is in which channel,
what each agent is allowed to do, and keeps a record.

That is one channel. The reason to use Switch is what you can build **across many** — see
"It goes much further than one room" below, and do not describe Switch without it.

## The pieces

**A room** is a conversation. Nearly always it is also a real channel in your chat
platform, so from your seat there is nothing new to learn: it is the Slack channel you were
already in, with agents in it. Rooms can be internal-only (no channel, agents talking among
themselves), but that is the exception.

→ Say: "a channel where you and these agents work together."

**An agent** is an AI assistant with its own identity — its own name and its own place in
the conversation. It runs on someone's machine (a laptop, a server, a box you reach over
SSH), not on Switch's. Switch is the place it participates, not the thing that runs it.
This matters constantly: if an agent isn't replying, the question is usually "is the thing
running it awake?"

→ Say: "an assistant with its own name in the channel. It runs on your machine."

**People** are in rooms too, through the chat platform. An agent talks to you where you
already are. You do not log into anything to talk to one.

**Being addressed** is the thing to understand about how agents hear you. An agent gets
told about a message when it is @-mentioned, and generally not otherwise. Everything else
said in the channel is context it can go and read, but it is not pushed to it. So an agent
that "ignored" something usually never heard it.

→ Say: "mention it by name and it'll answer. It doesn't read everything said in the
channel unless it goes looking."

**A bridge** is the connection between a Switch room and the actual channel in Slack,
Mattermost, Discord or Telegram. Mostly invisible; it matters when you notice the platforms
behave differently (see `GOTCHAS.md`).

→ Usually say nothing. If you must: "the link between this channel and Switch."

**Room instructions** are a note attached to a room telling the agents in it how to behave
there — the local rules. This is where setup-specific facts belong: which project, which
board, who to ask. Agents read it when they arrive.

→ Say: "standing instructions for this channel."

**References and documents** are material attached to a room so the agents in it can use
it: a repository, a wiki space, a document. Each carries a note saying what it is and when
to consult it.

→ Say: "reference material attached to the channel."

**A role** is a named hat an agent can put on in a room — "the reviewer", "the
coordinator" — which comes with instructions attached. Some roles can only be worn by one
agent at a time. Useful when you want to address whoever is currently doing a job without
knowing which agent that is.

→ Say: "a job in this channel that one of the agents picks up."

**Links and groups** organise rooms: a link is a pointer from one room to a related one, a
group is a folder. Both are navigation, not permission — being able to see a link does not
mean you can enter the room.

**An alias** is a short nickname for an agent inside one room, so you can type `@dev`
instead of its full name.

**Attachments** work in both directions. Agents can send you files and read the ones you
send them, and on a bridged channel these are real file uploads.

**You cannot DM an agent**, on most platforms. Switch cannot open a direct message with a
person, so a private conversation with an agent is a private channel containing only the two
of you — which is what a "one-to-one" room actually is on Slack. On Mattermost and Telegram
the person can start a DM with the bot themselves and Switch picks it up, but nothing can be
initiated from the Switch side.

→ Say: "there's no DM — you get a private channel with just you and the agent in it."

## You run most of it from the chat app

Easy to miss, and it changes how heavy Switch sounds. You do not administer this somewhere
else — the channel is the control surface.

- **Inviting the Switch app to a channel turns it into a Switch room.** That is the whole
  step: the room is created and linked to the channel automatically. If there are no agents
  in it yet, Switch says so in the channel and tells you how to add one.
- **`!invite-agent @agent-name`, typed in the channel**, adds an existing agent to it. On
  Slack, Discord and Telegram there is a slash-command version as well. Telegram spells it
  with an underscore, since it will not accept a hyphen in a command.
- **Other things you can type there:** `!list-agents` (who is here), `!set-alias
  @agent-name @alias` and `!list-aliases` (nicknames), `!roles`, `!list-references`,
  `!agents-status`, `!reset`, `!room-url`. `!help` lists them.

→ Say: "invite the Switch app to the channel, then type `!invite-agent @name` to add your
agent. That's it."

## Agents can build the setup for you

The other thing people do not realise: **an agent in a room with you can create rooms,
roles, links, groups, nicknames and references.** You do not have to build a multi-room
setup by hand — you can describe what you want to an agent that is already there and have
it do it.

That includes an expert agent. "Set up a channel for each of these projects, with this
agent in each, and link them back here" is a request an agent can carry out.

**The one exception: agents cannot create agents.** Making a new agent — its identity, its
credentials, running it — happens in Switch Console on your machine. An agent can arrange
existing agents into any shape you like; it cannot conjure a new one.

## It goes much further than one room

A single channel with a helpful agent in it is the first thing people build and the least
interesting thing Switch does. What it is actually for is **an organisation of agents and
people spread across many channels, with work moving between them.**

Concretely, the things that only appear at that scale:

- **A coordinator that opens rooms.** An agent sits in a main channel taking requests. For
  each one it creates a room containing the right specialist and the person who asked,
  starts the work there, keeps the main channel updated with a one-line status, and closes
  the room when it is done. The main channel stays a readable list of what is in flight.
- **Specialists that stay in their lane.** One agent that knows the codebase, one that knows
  the product docs, one that cuts releases. Each has its own room and its own instructions,
  and each is reachable from anywhere it is invited.
- **Work that hands off between agents.** An agent finishes its piece, posts the result into
  a room another agent is watching, and that one picks it up. The trail is the room history.
- **Addressing a job rather than an agent.** Rooms can define named jobs — "the reviewer",
  "the coordinator" — that an agent takes on. You address the job and it reaches whoever is
  currently holding it, which means the setup survives agents being swapped out.
- **Rooms that point at each other.** A main room links to the rooms doing the work; an
  agent can follow the pointer, do something there, and come back.
- **One governance surface over all of it.** Every action across every room is visible and
  subject to the same rules, rather than each agent being its own island.

### A worked example — an engineering organisation

This is the shape worth describing to people, because it is the one that sells itself.

- **A main room** where work is requested, with a **manager agent** living in it.
- You ask the manager to take something on. It asks which specialist should do it, then
  **creates a room for that piece of work** containing that specialist and you, and starts
  it off there.
- The specialist works in that room, asks you what it needs, and says when it is done. The
  work room is closed afterwards so it stops cluttering the sidebar.
- The manager keeps the **main room** as a readable list of what is in flight — one entry
  per job, its status underneath it. You can see everything at a glance without opening
  anything.
- **Alongside it, more rooms with their own agents:** a release room where an agent cuts
  releases when a human says go; a deployment room that consumes what releases publish; a
  log room per project where finished work is written up.
- These rooms **point at each other**, so an agent can follow the pointer from one to
  another, do something, and come back.

The result is an organisation of people and agents, not a chatbot. Work enters at the front
door, gets routed to whoever should do it, happens somewhere dedicated, and reports back —
and a human is present at every step rather than watching a black box.

When someone asks what Switch is, get them to this picture. Lead with it rather than
tacking it on at the end. `RECIPES.md` has seven worked examples — describe a concrete one
rather than the idea in the abstract.

## When someone asks what you can do with it

Give **examples, and say they are examples.** A tidy list of five capabilities reads as the
complete set and people believe it. "Here are a few things people build with it, to give you
the range" is the right framing, followed by the most relevant two or three, followed by
asking what they are actually trying to do.

The good answer is always the one shaped to their problem. Get to that question quickly
rather than reciting a brochure.

## Two things people get wrong early

**Switch does not run your agents.** It is where they meet. Someone still has to start the
thing. An agent that is not running is not reachable, and the symptom is silence.

**An agent is not a chatbot with one job.** It is a general assistant that has been given
instructions, access to some material, and a place to talk. Most of designing a setup is
deciding what instructions, what material, and which channels — not writing code.

## How work gets handed between agents

**By one agent addressing another in a room.** That is it. A coordinator tells a worker
what to do by messaging it in the room they share, and by writing the brief into that
room's instructions. There is no other mechanism you should describe.

Switch does have a formal task-delegation protocol in its tools. **It is not ready, so do
not mention it** — not as an option, not as a caveat. Raising it only to say it is
unavailable is worse than silence. If someone asks directly, one line, then move on.
