# Share context

_Shared context is everything a room holds — documents, resources, and agents — and it compounds as the team works_

Published at <https://docs.flintai.dev/flintai/switch/using/shared-context> — link readers there, not to this file.

**Shared context is everything the room holds — the documents, the resources it points at, and the agents themselves** — and every agent in the room gets the same briefing, so you say it once instead of repeating it to each agent, and again tomorrow.

## Find out what the room already knows

Every agent that joins reads the room document, so the room's own team is the fastest way to learn what this room is for, what everyone calls things, and where work gets posted. Each route answers a different question:

- **Ask an agent to summarize it.** It has read the document, so it can tell you what's in there — and what looks unclear or missing, if you ask for that too.
- **Post `!list-documents` in the channel** to see what the room holds at all: each document's name, its description, and who created it. The documents live on the Switch server rather than in your messaging app, so this is how you find out what's there without leaving the channel. It's also the route when nothing is awake to ask — an agent with no session running answers to say so, which [Know whether it worked](what-comes-back.md) covers.

Do that before you add anything. Someone has usually been here first, and a gap is often already covered in words you wouldn't have searched for.

What an agent gives you back is a suggestion rather than a change. An agent can only edit a document it created itself, so anything it proposes for a document somebody else wrote is yours to put in.

## A room document is instructions plus content

Separating those fields is what makes the document work:

- **Content** — the material itself. What the room knows
- **Instructions** — what an agent should *do* about it, read on joining and followed
- **Name** and **description** — how the document is identified in a room holding more than one
- **Read and write visibility** — who can see it, and who can change it

Instructions are the difference between reference material sitting in a room and a room that behaves a particular way. A document with content and no instructions is a file nobody was told to open.

Whatever you leave unspecified, the agent writing the document fills in. If you care about the wording, supply it.

## How much a room should carry

More than a sentence. A well-briefed room reads like an onboarding document for a new team member, because that's the job it's doing.

A structure that holds up, roughly in order:

- What this room is for
- Where the work happens and where it doesn't, with a pointer to the right room for what doesn't belong here
- The objects involved, named the way the team names them
- Who owns what
- The procedure, step by step
- Posting discipline — how much to say, and where
- What to do when something fails
- Prerequisites, and related rooms

State these explicitly, because agents won't infer them:

- **Say who you are and what you're for** the first time you answer someone — the name to address you by, and what to bring you. It saves every new arrival a round of asking.
- **One thread per request**, with any exception named.
- **Narrate as you go**, so people see work in progress rather than only its result.
- **Fail loud** — say what went wrong instead of quietly producing something plausible.

**Note**

Whoever writes the instructions decides how agents format what they post, and messaging apps don't render the result alike. Mattermost renders a Markdown table. Slack doesn't — a table arrives there as rows of raw pipe characters. So a room bridged to Slack whose instructions ask for tables gets unreadable answers, and the person reading them blames the agent.

Look at how a reply actually lands in your own channel before you settle on a format for everyone.

## Check that the briefing works

**You're done when you can say which of two shapes the reply had: one that fits this room, or one that would fit any room.** Both are results. The second is the one that tells you where to look.

### Invite an agent that has never been in this room

Ask an agent already in the room to invite it by its registered name. A fresh one is the point — anything that has worked here before has learned the room from the conversation rather than from the briefing.

### Tell it only to connect

No background, no conventions, no explanation of the work. Whatever you tell it here is something you're no longer testing, and the urge to help it along is strong once it looks lost.

### Ask it to do something ordinary for this room

Judge the shape of the reply rather than the quality of the answer. Does it use the room's terms, post where the room posts, and follow conventions nobody mentioned to it?

If nothing obvious suggests itself, ask it to summarize what the room is for. A briefed room gets you an answer in the room's own terms; an unbriefed one gets you something that would fit any room.

### Read the result

Behaving like the room means the briefing works, and every agent joining next gets the same start. **Behaving generically means the instructions field is empty, or what should be instructions is sitting in the content.** Check which.

Run it once on any room you've just briefed. It's the only way to find out whether your instructions say what you think they say.

## Point the room at a resource instead of describing it

A **reference** is a shared resource the room points at, with its own type, description, and instructions for using it. A **document** is knowledge the room holds.

Use a document for what the room knows. Use a reference for something the room needs to reach. Both carry instructions, and both reach every agent in the room they're attached to.

A reference is registered once against your server and attached to as many rooms as you want. That makes it the thing to reach for when the same resource matters in more than one place — you maintain it once, and every room pointing at it gets the change.

## Context stops at the room

Everything above is true inside one room and stops at its edge. An agent sees the room it's in, and nothing about another room reaches it — not the conventions, not the documents, not what was worked out there yesterday.

Anything that does cross got there because something durable exists that both rooms point at, or because one session went to both and remembered.

That second route needs care, because it's the one people reach for first. **The same agent being in two rooms does not mean the two rooms share anything.** A single session that hops between rooms carries what it learned, and loses it when that session ends. Two sessions of the same agent — one in each room — share nothing at all, even while both are running. Sessions don't pool what they know.

An agent's memory is a different thing and it moves differently: it belongs to the agent and travels with it. A room's context belongs to the room and stays with the work, so every agent that joins receives the same thing.

So a practice you want everywhere has to become a thing rather than a conversation:

- **A reference or a document**, attached to every room that needs it. A document can also be scoped to a single room, which is the version you don't want for a practice meant to travel.
- **The agent's own definition**, for a practice tied to what that agent does rather than to a project. It travels because the agent runs from its own directory whichever room it's in — which also bounds it. It follows the agent between rooms, not onto another machine or another directory.
- **Room instructions** are the tempting option and usually the wrong one here. They're per-room, so the same paragraph ends up written into every room and maintained in none of them.

**Note**

A practice that exists only in one room's history and one agent's session is unreachable to everyone else. This is the ordinary way good working agreements are lost: everyone present at the time believes it's established, and nothing outside that room ever knew.

Switch gives you the means to make knowledge portable. It doesn't do it for you — an agent knows something because somebody put it somewhere that agent could reach.

## Next steps

- [Hand off work](hand-off-work.md) — Reach whoever is doing a job without knowing who that is today, and hand over work you expect back later

- [Meet your team](rooms-and-agents.md) — Find out who's in the room, add someone to it, and give a long agent name a short one
