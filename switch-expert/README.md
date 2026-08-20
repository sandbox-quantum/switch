# Switch expert

An agent you stand up yourself that answers questions about Switch and helps you design
and build things with it.

There is no service to sign up for. This folder is the agent: a block of instructions plus
the knowledge it reads. You create an agent on your own machine, give it these
instructions, and it does the rest.

## Stand one up

Use **Switch Console**. It creates the agent, gives it its identity and credentials, and
holds its instructions — an agent set up outside it does not connect to Switch properly.

1. **Add an agent in Switch Console.** Pick a working directory for it, the server it
   belongs to, and whether it runs on this machine or on a host you reach over SSH.
2. **Paste the contents of [`AGENT.md`](AGENT.md)** into the agent's instructions.
3. **That's it.** The first thing it does is clone this repository into its own directory
   and read the knowledge files below. You do not need to copy anything.

Then invite it to a room and bridge that room to your team's chat, so people reach it where
they already work. Give it a short nickname in the room so nobody has to type its full
name, and widen who may address it if teammates need it — by default an agent answers only
its owner.

Run it somewhere that stays up. It can only answer while it is running, so if a team is
going to rely on it, that means a server rather than a laptop that closes.

> Without Switch Console, the connector's `configure` step can register a plain terminal
> session as an agent. It works, but it is deliberately not feature-complete — no
> auto-started sessions, no pushing a message into a running session, and **no per-agent
> instructions**, which are the whole point of an expert agent. Treat it as a fallback.

## What it reads

| File | What it is |
|---|---|
| [`knowledge/INDEX.md`](knowledge/INDEX.md) | What each file is for and when to read it. The agent starts here. |
| [`knowledge/CONCEPTS.md`](knowledge/CONCEPTS.md) | The mental model, in plain language. |
| [`knowledge/PATTERNS.md`](knowledge/PATTERNS.md) | Reusable patterns for shaping a setup. |
| [`knowledge/RECIPES.md`](knowledge/RECIPES.md) | Worked setups to copy and adapt. |
| [`knowledge/CHECKLIST.md`](knowledge/CHECKLIST.md) | What to settle before building anything. |
| [`knowledge/GOTCHAS.md`](knowledge/GOTCHAS.md) | Traps that cost people days. |
| [`CORRECTIONS.md`](CORRECTIONS.md) | Where being wrong gets recorded. |

It also reads the rest of this repository — `docs/` for how Switch is designed, the
connector skill under `connectors/*/skills/switch/` for how rooms and messaging actually
work, and the source when the docs are silent.

## How this stays current

Switch changes weekly, and a knowledge file that goes quietly out of date is worse than no
knowledge file at all: it answers confidently and wrongly, and you have no way to tell.
Three things keep that in check.

**It lives in the product repository.** Changing how Switch behaves and changing what the
expert knows about it are the same pull request, reviewed together. There is no separate
place someone has to remember to update.

**It re-reads rather than remembers.** The agent pulls this repository at the start of
every conversation. The fastest-moving material — how rooms and messaging work — is not
copied into these files at all; the agent reads the connector skill that ships and is
versioned with the server. Versions, download links and UI labels are never written down as
values, only as instructions for looking them up.

**Being wrong has somewhere to land.** [`CORRECTIONS.md`](CORRECTIONS.md) is an
append-only log. The agent is told to write there the moment it is proven wrong and to open
a pull request with the fix. Each knowledge file carries a line saying what it was last
checked against, and the agent tells you when it is answering from something older than the
server you are asking about.

## When it doesn't know

It says so, says where the answer would live, and offers to go and look. It does not invent
a version number, a URL or a menu item. If you catch it doing so, that is a correction —
tell it, and it will log it.

## Contributing

Corrections and additions are welcome as pull requests. If you are fixing something the
agent got wrong, add the entry to `CORRECTIONS.md` as well as fixing the knowledge file, so
the record of what was wrong survives.
